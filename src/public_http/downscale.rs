//! Oversized sender images are shrunk before they reach Qt, which decodes every
//! embedded image at full size on the GUI thread each time the reader repaints.
//! Only PNG and JPEG are touched; anything else, anything small enough, and
//! anything that fails to decode passes through unchanged.
use image::{
    DynamicImage, ImageDecoder, ImageError, ImageFormat, ImageReader, Limits,
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
    imageops::FilterType,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    io::Cursor,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{Arc, Mutex, OnceLock},
};
use tokio::sync::{Semaphore, SemaphorePermit};

/// An image at or under both of these is left exactly as the sender made it:
/// re-encoding one that is only a little too big costs sharpness for no gain.
const KEEP_WIDTH: u32 = 2400;
const KEEP_PIXELS: u64 = 6_000_000;
/// What a larger image is shrunk to. 1600 is twice a typical reader column, so
/// a high-density display stays sharp; Qt decodes every pixel, so tall images
/// are bounded by area as well.
const MAX_WIDTH: u32 = 1600;
const MAX_PIXELS: u64 = 4_000_000;
/// Declared size above which an image is refused: it cannot be decoded within
/// `MAX_ALLOC`, and Qt's own allocation limit would refuse it too.
const MAX_SOURCE_PIXELS: u64 = 100_000_000;
/// Peak heap one decode and resize may use.
const MAX_ALLOC: u64 = 512 * 1024 * 1024;
/// Heap held beyond the decoded pixels, measured with `image` 0.25.10 on JPEG
/// and PNG, 8 and 16 bit, 24 to 67 MP, square, tall and wide. The decode and the
/// resize run one after the other, so the larger of the two counts:
/// - the resize keeps its intermediate (the source width by the target height)
///   as four `f32` channels whatever the image holds, 16 bytes a pixel;
/// - an interlaced PNG is assembled in a second full-size buffer, and a
///   progressive JPEG keeps a 16-bit coefficient per component and pixel.
///
/// `WORKING_FIXED` covers the rest (the output, the encoder, allocator slack);
/// the largest overshoot measured past the other terms was 32 MiB.
/// `an_accepted_image_never_exceeds_the_allocation_budget` and its siblings
/// re-check the price.
const WORKING_FIXED: u64 = 64 * 1024 * 1024;
const RESIZE_BYTES_PER_PIXEL: u64 = 16;
const COEFFICIENT_BYTES: u64 = 2;
const JPEG_QUALITY: u8 = 90;
const CACHE_BYTES: usize = 32 * 1024 * 1024;
const CACHE_ENTRIES: usize = 512;

type Key = [u8; 32];

/// What was decided for one body. Failures are remembered too, so an image
/// that costs a full decode before it fails does not cost it again.
#[derive(Clone)]
pub(super) enum Entry {
    Smaller(Arc<Vec<u8>>),
    Keep,
    Refuse,
}

impl Entry {
    fn bytes(&self) -> usize {
        match self {
            Entry::Smaller(data) => data.len(),
            _ => 0,
        }
    }
}

#[derive(Default)]
pub(super) struct Cache {
    bytes: usize,
    order: VecDeque<Key>,
    items: HashMap<Key, Entry>,
}

impl Cache {
    pub(super) fn get(&mut self, key: &Key) -> Option<Entry> {
        let hit = self.items.get(key)?.clone();
        self.order.retain(|k| k != key);
        self.order.push_back(*key);
        Some(hit)
    }

    pub(super) fn put(&mut self, key: Key, value: Entry) {
        if value.bytes() > CACHE_BYTES || self.items.contains_key(&key) {
            return;
        }
        self.bytes += value.bytes();
        self.order.push_back(key);
        self.items.insert(key, value);
        while self.bytes > CACHE_BYTES || self.items.len() > CACHE_ENTRIES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(gone) = self.items.remove(&oldest) {
                self.bytes -= gone.bytes();
            }
        }
    }
}

pub(super) fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// One decode at a time bounds the transient memory to `MAX_ALLOC`. Waiting
/// here is asynchronous, so a queue of large images holds no blocking thread.
pub async fn slot() -> SemaphorePermit<'static> {
    static SLOTS: Semaphore = Semaphore::const_new(1);
    SLOTS
        .acquire()
        .await
        .expect("the semaphore is never closed")
}

pub enum Prepared {
    Original,
    Smaller(Arc<Vec<u8>>),
}

/// The bytes to show for a sniffed `image/png` or `image/jpeg` body. Call it
/// while holding `slot()`.
pub fn prepare(mime: &str, data: &[u8]) -> Result<Prepared, &'static str> {
    let format = match mime {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        _ => return Ok(Prepared::Original),
    };
    let key: Key = Sha256::digest(data).into();
    let remembered = cache().lock().unwrap_or_else(|e| e.into_inner()).get(&key);
    let entry = match remembered {
        Some(entry) => entry,
        None => {
            // A decoder that panics on a hostile body must cost one image, not
            // the request.
            let decided = catch_unwind(AssertUnwindSafe(|| shrink(format, data)));
            let entry = match decided {
                Ok(Ok(Some(smaller))) => Entry::Smaller(Arc::new(smaller)),
                Ok(Err(ImageError::Limits(_))) => Entry::Refuse,
                Ok(Ok(None)) => return Ok(Prepared::Original),
                Ok(Err(_)) | Err(_) => Entry::Keep,
            };
            cache()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .put(key, entry.clone());
            entry
        }
    };
    match entry {
        Entry::Smaller(smaller) => Ok(Prepared::Smaller(smaller)),
        Entry::Keep => Ok(Prepared::Original),
        Entry::Refuse => Err("public_image_refused"),
    }
}

fn target(width: u32, height: u32) -> Option<(u32, u32)> {
    let area = u64::from(width) * u64::from(height);
    if width <= KEEP_WIDTH && area <= KEEP_PIXELS {
        return None;
    }
    let scale = (f64::from(MAX_WIDTH) / f64::from(width))
        .min((MAX_PIXELS as f64 / area as f64).sqrt())
        .min(1.0);
    let scaled = |side: u32| ((f64::from(side) * scale).round() as u32).max(1);
    Some((scaled(width), scaled(height)))
}

/// The component count of a progressive JPEG, from its start-of-frame header.
fn progressive_components(data: &[u8]) -> Option<u64> {
    let mut at = 2;
    while at + 4 <= data.len() {
        if data[at] != 0xff {
            return None;
        }
        let marker = data[at + 1];
        match marker {
            0xff => at += 1,
            0x01 | 0xd0..=0xd9 => at += 2,
            // A scan before any frame header: not a JPEG this reads.
            0xda => return None,
            0xc2 | 0xc6 | 0xca | 0xce => return data.get(at + 9).map(|n| u64::from(*n)),
            0xc0..=0xcf if marker != 0xc4 && marker != 0xc8 && marker != 0xcc => return None,
            _ => at += 2 + usize::from(u16::from_be_bytes([data[at + 2], data[at + 3]])),
        }
    }
    None
}

fn limit_error() -> ImageError {
    ImageError::Limits(image::error::LimitError::from_kind(
        image::error::LimitErrorKind::InsufficientMemory,
    ))
}

fn shrink(format: ImageFormat, data: &[u8]) -> Result<Option<Vec<u8>>, ImageError> {
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_ALLOC);
    let mut reader = ImageReader::with_format(Cursor::new(data), format);
    reader.limits(limits);
    let mut decoder = reader.into_decoder()?;
    let (width, height) = decoder.dimensions();
    let pixels = u64::from(width) * u64::from(height);
    if pixels > MAX_SOURCE_PIXELS {
        return Err(limit_error());
    }
    let orientation = decoder.orientation()?;
    // The sides the reader will show, after the camera's rotation is applied.
    let turned = orientation.to_exif() > 4;
    let shown = if turned {
        (height, width)
    } else {
        (width, height)
    };
    let Some((wide, high)) = target(shown.0, shown.1) else {
        return Ok(None);
    };
    // Resize first and rotate the small copy, so the rotation never holds a
    // second full-size buffer.
    let (wide, high) = if turned { (high, wide) } else { (wide, high) };
    // Refuse before decoding anything if the peak would pass the budget.
    let total = decoder.total_bytes();
    let decoding = if format == ImageFormat::Png && data.get(28) == Some(&1) {
        total
    } else {
        progressive_components(data).map_or(0, |n| pixels * n * COEFFICIENT_BYTES)
    };
    let resizing = u64::from(width) * u64::from(high) * RESIZE_BYTES_PER_PIXEL;
    let needed = total
        .saturating_add(decoding.max(resizing))
        .saturating_add(WORKING_FIXED);
    if needed > MAX_ALLOC {
        return Err(limit_error());
    }
    let mut picture = DynamicImage::from_decoder(decoder)?;
    picture = picture.resize_exact(wide, high, FilterType::CatmullRom);
    picture.apply_orientation(orientation);
    let mut out = Vec::new();
    match format {
        ImageFormat::Jpeg => DynamicImage::ImageRgb8(picture.to_rgb8())
            .write_with_encoder(JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY))?,
        _ if picture.color().has_alpha() => DynamicImage::ImageRgba8(picture.to_rgba8())
            .write_with_encoder(PngEncoder::new(&mut out))?,
        _ => DynamicImage::ImageRgb8(picture.to_rgb8())
            .write_with_encoder(PngEncoder::new(&mut out))?,
    }
    Ok(Some(out))
}
