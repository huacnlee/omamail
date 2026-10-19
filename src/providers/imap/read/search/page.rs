//! Reuse the search order, but verify the small page before returning its IDs.
//! Expunged candidates do not become ghost rows, and UIDVALIDITY is checked
//! even on a cache hit. Four folders per call keeps page assembly resumable.
use super::*;

impl Snapshot {
    pub(super) async fn verify_page(
        &mut self,
        p: &Value,
        cursor: Option<&Cursor>,
        limit: usize,
    ) -> Result<bool> {
        let offset = self.offset(cursor);
        let ordered = self.ordered.as_ref().ok_or("imap_invalid_response")?;
        let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
        for &(f, m) in ordered.iter().skip(offset).take(limit) {
            if !self.verified.contains(&(f, m)) {
                groups.entry(f).or_default().push(m);
            }
        }
        let gate = gate(self.owner).await;
        let mut work = FuturesUnordered::new();
        for (f, indices) in groups.into_iter().take(WORKERS) {
            let folder = &self.folders[f];
            let gate = gate.clone();
            work.push(worker(gate, async move {
                let uids = indices
                    .iter()
                    .map(|m| folder.messages[*m].uid.to_string())
                    .collect::<Vec<_>>()
                    .join(",");
                let (mut wire, key) = acquire(p).await?;
                let selected =
                    command(&mut wire, &format!("SELECT {}", quote(&folder.name)?)).await?;
                if Some(validity(&selected)?) != folder.validity {
                    return Err("imap_search_expired");
                }
                let data = command(&mut wire, &format!("UID FETCH {uids} (UID)")).await?;
                let present = fetched_dates(&data)?;
                release(wire, key).await;
                Ok((
                    f,
                    indices
                        .into_iter()
                        .map(|m| (m, present.contains_key(&folder.messages[m].uid)))
                        .collect::<Vec<_>>(),
                ))
            }));
        }
        let mut missing = BTreeSet::new();
        while let Some(result) = work.next().await {
            let (f, results) = result?;
            for (m, present) in results {
                if present {
                    self.verified.insert((f, m));
                } else {
                    missing.insert((f, m));
                }
            }
        }
        drop(work);
        self.ordered
            .as_mut()
            .unwrap()
            .retain(|i| !missing.contains(i));
        // Deletion may bring more candidates into the page. Verify those on
        // the next continuation rather than returning a short or stale page.
        Ok(self
            .ordered
            .as_ref()
            .unwrap()
            .iter()
            .skip(self.offset(cursor))
            .take(limit)
            .all(|i| self.verified.contains(i)))
    }
}
