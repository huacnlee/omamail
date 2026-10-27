//! NTLMv2 with the TLS channel binding, written from MS-NLMP (section numbers are its) and RFC 5929.
//!
//! Only what an Exchange sign-in needs: no LM or NTLMv1 response, no signing or sealing. The server
//! must answer with a timestamped TargetInfo, which arms the MIC and the channel binding; without
//! one the sign-in fails rather than being answered unprotected (a relaying peer could provoke the
//! downgrade). The module is pure: the client challenge and the certificate are inputs.

use hmac::{Hmac, KeyInit, Mac};
use md4::Md4;
use md5::{Digest as _, Md5};
use sha2::{Digest as _, Sha256, Sha384, Sha512};
use zeroize::Zeroizing;

const AUTH: &str = "exchange_auth_failed";
const TLS: &str = "exchange_tls_failed";
const SIGNATURE: &[u8; 8] = b"NTLMSSP\0";

// Negotiate flags (2.2.2.5): Unicode, request target, NTLM, always sign, extended session
// security, target info (answer only) and 128-bit.
const NEGOTIATE: u32 =
    0x0000_0001 | 0x0000_0004 | 0x0000_0200 | 0x0000_8000 | 0x0008_0000 | 0x2000_0000;
const KEEP: u32 = NEGOTIATE | 0x0080_0000;
const UNICODE: u32 = 1;
const TARGET_INFO: u32 = 0x0080_0000;
const AV_EOL: u16 = 0;
const AV_FLAGS: u16 = 6;
const AV_TIMESTAMP: u16 = 7;
const AV_TARGET_NAME: u16 = 9;
const AV_CHANNEL_BINDINGS: u16 = 10;
const MIC_PRESENT: u32 = 2;
/// Header up to the MIC field, and the MIC (2.2.1.3).
const HEADER: usize = 72;
const MIC: usize = 16;

pub fn negotiate() -> Vec<u8> {
    let mut m = SIGNATURE.to_vec();
    m.extend(1u32.to_le_bytes());
    m.extend(NEGOTIATE.to_le_bytes());
    // Empty domain and workstation fields pointing at the end of the 40-byte message, then a
    // zero Version.
    for _ in 0..2 {
        m.extend([0, 0, 0, 0]);
        m.extend(40u32.to_le_bytes());
    }
    m.extend([0; 8]);
    m
}

fn hmac_md5(key: &[u8], parts: &[&[u8]]) -> Zeroizing<[u8; 16]> {
    let mut mac = <Hmac<Md5> as KeyInit>::new_from_slice(key).expect("HMAC takes any key length");
    for part in parts {
        mac.update(part);
    }
    Zeroizing::new(mac.finalize().into_bytes().into())
}

fn utf16(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(u16::to_le_bytes).collect()
}

/// NTOWFv2 (3.3.2): `HMAC_MD5(MD4(UNICODE(password)), UNICODE(Upper(user) + domain))`. Windows maps
/// one UTF-16 unit to one unit, so a letter whose uppercase is longer (U+00DF) stays as it is.
pub(super) fn ntowf_v2(password: &str, user: &str, domain: &str) -> Zeroizing<[u8; 16]> {
    let wide = Zeroizing::new(utf16(password));
    let nt_hash = Zeroizing::new(<[u8; 16]>::from(Md4::digest(&wide[..])));
    let upper: String = user
        .chars()
        .map(|c| {
            let mut upper = c.to_uppercase();
            match (upper.next(), upper.next()) {
                (Some(single), None) => single,
                _ => c,
            }
        })
        .collect();
    hmac_md5(&nt_hash[..], &[&utf16(&(upper + domain))])
}

/// The NTLMv2 response (2.2.2.8) over `target_info` and the SessionBaseKey (3.3.2).
pub(super) fn ntlmv2(
    key: &[u8; 16],
    server_challenge: &[u8],
    client_challenge: &[u8; 8],
    time: &[u8],
    target_info: &[u8],
) -> (Vec<u8>, Zeroizing<[u8; 16]>) {
    let mut temp = vec![1, 1, 0, 0, 0, 0, 0, 0];
    temp.extend(time);
    temp.extend(client_challenge);
    temp.extend([0; 4]);
    temp.extend(target_info);
    temp.extend([0; 4]);
    let proof = hmac_md5(key, &[server_challenge, &temp]);
    let session_base_key = hmac_md5(key, &[&proof[..]]);
    ([&proof[..], &temp].concat(), session_base_key)
}

fn read<const N: usize>(bytes: &[u8], at: usize) -> Result<[u8; N], &'static str> {
    bytes
        .get(at..at + N)
        .and_then(|slice| slice.try_into().ok())
        .ok_or(AUTH)
}

/// The AV pairs of a CHALLENGE_MESSAGE's TargetInfo (without the closing MsvAvEOL) and its
/// timestamp.
type Pairs = Vec<(u16, Vec<u8>)>;

fn challenge_pairs(challenge: &[u8]) -> Result<(Pairs, [u8; 8]), &'static str> {
    if challenge.len() > 32 * 1024
        || challenge.get(..8) != Some(&SIGNATURE[..])
        || u32::from_le_bytes(read(challenge, 8)?) != 2
        || u32::from_le_bytes(read(challenge, 20)?) & (UNICODE | TARGET_INFO)
            != (UNICODE | TARGET_INFO)
    {
        return Err(AUTH);
    }
    let len = usize::from(u16::from_le_bytes(read(challenge, 40)?));
    let offset = u32::from_le_bytes(read(challenge, 44)?) as usize;
    let mut info = challenge
        .get(offset..offset.saturating_add(len))
        .ok_or(AUTH)?;
    let (mut pairs, mut timestamp) = (Vec::new(), None);
    loop {
        let [id0, id1, len0, len1] = read(info, 0)?;
        let (id, len) = (
            u16::from_le_bytes([id0, id1]),
            usize::from(u16::from_le_bytes([len0, len1])),
        );
        let value = info.get(4..4 + len).ok_or(AUTH)?;
        info = &info[4 + len..];
        match id {
            AV_EOL => return timestamp.map(|time| (pairs, time)).ok_or(AUTH),
            AV_TIMESTAMP => timestamp = Some(value.try_into().map_err(|_| AUTH)?),
            _ => {}
        }
        pairs.push((id, value.to_vec()));
    }
}

/// The AUTHENTICATE_MESSAGE (2.2.1.3) answering `challenge`, with the MIC, `spn` as MsvAvTargetName
/// and `binding` as MsvAvChannelBindings. `login` is `DOMAIN\user`, a UPN or a bare name.
pub fn authenticate(
    login: &str,
    password: &str,
    negotiate: &[u8],
    challenge: &[u8],
    client_challenge: [u8; 8],
    spn: &str,
    binding: [u8; 16],
) -> Result<Vec<u8>, &'static str> {
    let (domain, user) = login.split_once('\\').unwrap_or(("", login));
    if user.is_empty() || password.is_empty() || login.len() > 512 {
        return Err("invalid_params");
    }
    let (pairs, time) = challenge_pairs(challenge)?;
    let mut info = Vec::new();
    let mut put = |id: u16, value: &[u8]| {
        info.extend(id.to_le_bytes());
        info.extend((value.len() as u16).to_le_bytes());
        info.extend(value);
    };
    let mut flags_seen = false;
    for (id, value) in &pairs {
        match *id {
            AV_CHANNEL_BINDINGS | AV_TARGET_NAME => {}
            AV_FLAGS => {
                let flags = u32::from_le_bytes(value.as_slice().try_into().map_err(|_| AUTH)?);
                put(AV_FLAGS, &(flags | MIC_PRESENT).to_le_bytes());
                flags_seen = true;
            }
            id => put(id, value),
        }
    }
    if !flags_seen {
        put(AV_FLAGS, &MIC_PRESENT.to_le_bytes());
    }
    put(AV_CHANNEL_BINDINGS, &binding);
    put(AV_TARGET_NAME, &utf16(spn));
    put(AV_EOL, &[]);

    let key = ntowf_v2(password, user, domain);
    let (domain, user) = (utf16(domain), utf16(user));
    let (nt, session_base_key) = ntlmv2(&key, &challenge[24..32], &client_challenge, &time, &info);
    let flags = u32::from_le_bytes(read(challenge, 20)?) & KEEP;
    // Payload order: domain, user, workstation, LM, NT, session key; LM is all zero with a MIC.
    let payload: [&[u8]; 6] = [&domain, &user, &[], &[0; 24], &nt, &[]];
    let mut offsets = [0; 6];
    let mut end = HEADER + MIC;
    for (offset, field) in offsets.iter_mut().zip(payload) {
        *offset = end;
        end += field.len();
    }
    let mut m = SIGNATURE.to_vec();
    m.extend(3u32.to_le_bytes());
    for i in [3, 4, 0, 1, 2, 5] {
        m.extend((payload[i].len() as u16).to_le_bytes().repeat(2));
        m.extend((offsets[i] as u32).to_le_bytes());
    }
    m.extend(flags.to_le_bytes());
    m.extend([0; 8 + MIC]);
    for field in payload {
        m.extend(field);
    }
    let mic = hmac_md5(&session_base_key[..], &[negotiate, challenge, &m]);
    m[HEADER..HEADER + MIC].copy_from_slice(&mic[..]);
    Ok(m)
}

/// The value of MsvAvChannelBindings for the server certificate (DER): the MD5 of a
/// `gss_channel_bindings_struct` (RFC 4121 4.1.1.2) with zero addresses whose application data is
/// `tls-server-end-point:` plus the certificate hash (RFC 5929 4.1) of the hash its signature
/// algorithm names, SHA-1 and MD5 giving SHA-256. Microsoft's "NTLM and Channel Binding Hash" article
/// fixes the struct.
pub fn channel_binding(cert: &[u8]) -> Result<[u8; 16], &'static str> {
    // Certificate ::= SEQUENCE { tbsCertificate SEQUENCE, signatureAlgorithm SEQUENCE { OID, .. }, .. }
    let (certificate, _) = der(cert, 0x30)?;
    let (_, rest) = der(certificate, 0x30)?;
    let (algorithm, _) = der(rest, 0x30)?;
    let (oid, _) = der(algorithm, 0x06)?;
    let end_point = match oid {
        // sha256, sha384 and sha512 with RSA (PKCS #1), then ECDSA with SHA-256, -384 and -512;
        // the SHA-1 and MD5 forms are no chain TLS verification accepts.
        [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]
        | [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02] => Sha256::digest(cert).to_vec(),
        [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0c]
        | [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03] => Sha384::digest(cert).to_vec(),
        [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0d]
        | [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x04] => Sha512::digest(cert).to_vec(),
        _ => return Err(TLS),
    };
    let data = [b"tls-server-end-point:".as_slice(), &end_point].concat();
    let mut md5 = Md5::new();
    md5.update([0u8; 16]);
    md5.update((data.len() as u32).to_le_bytes());
    md5.update(&data);
    Ok(md5.finalize().into())
}

/// One DER element with the expected tag: its content and what follows.
fn der(input: &[u8], tag: u8) -> Result<(&[u8], &[u8]), &'static str> {
    let [t, first, rest @ ..] = input else {
        return Err(TLS);
    };
    let (len, rest) = match *first {
        n if n < 0x80 => (usize::from(n), rest),
        n @ 0x81..=0x84 => {
            let n = usize::from(n & 0x7f);
            let digits = rest.get(..n).ok_or(TLS)?;
            (
                digits.iter().fold(0, |len, d| len << 8 | usize::from(*d)),
                &rest[n..],
            )
        }
        _ => return Err(TLS),
    };
    if *t != tag || len > rest.len() {
        return Err(TLS);
    }
    Ok(rest.split_at(len))
}
