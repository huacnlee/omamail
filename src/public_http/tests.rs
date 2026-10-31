use super::*;
use sha2::Digest;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[test]
fn refuses_nonpublic_and_transition_addresses() {
    for ip in [
        "127.0.0.1",
        "0.0.0.0",
        "10.1.2.3",
        "100.64.0.1",
        "169.254.169.254",
        "172.31.1.1",
        "192.168.1.1",
        "192.0.0.9",
        "192.88.99.1",
        "198.18.0.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "240.0.0.1",
        "::",
        "::1",
        "::ffff:8.8.8.8",
        "64:ff9b::808:808",
        "2001::1",
        "2001:db8::1",
        "2002:808:808::1",
        "fc00::1",
        "fe80::1",
        "fec0::1",
        "ff02::1",
        "3fff::1",
    ] {
        assert!(!is_public(ip.parse().unwrap()), "{ip}");
    }
    for ip in [
        "8.8.8.8",
        "1.1.1.1",
        "2606:4700:4700::1111",
        "2001:4860:4860::8888",
    ] {
        assert!(is_public(ip.parse().unwrap()), "{ip}");
    }
    assert!(checked_addresses(vec![]).is_err());
    assert!(
        checked_addresses(vec![
            "8.8.8.8".parse().unwrap(),
            "127.0.0.1".parse().unwrap()
        ])
        .is_err()
    );
    assert_eq!(
        checked_addresses(vec!["8.8.8.8".parse().unwrap()]).unwrap()[0],
        "8.8.8.8:0".parse().unwrap()
    );
}

#[test]
fn raw_url_bytes_are_validated_before_normalization() {
    for url in [
        "https://example.org/\n",
        "\thttps://example.org/",
        "https://example.org/\r\n",
        "https://example.org/\0",
        "https://example.org\\@127.0.0.1/",
        "https://user:secret@example.org/",
        "file:///tmp/mail",
        "https://localhost/",
        "https://127.1/",
        "https://2130706433/",
        "https://0x7f000001/",
        "https://[::ffff:127.0.0.1]/",
        "http://192.168.1.1/",
        "https://example.org:0/",
        "https://example.org./",
    ] {
        assert!(parse_url(url, false).is_err(), "{url:?}");
    }
    assert!(parse_url("http://example.org/", true).is_err());
    assert!(parse_url("https://example.org/日本?a=%22%5C&b=hello", true).is_ok());
}

async fn server(response: Vec<u8>) -> (SocketAddr, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let job = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut block = [0; 1024];
        loop {
            let n = stream.read(&mut block).await.unwrap();
            if n == 0 {
                break;
            }
            request.extend_from_slice(&block[..n]);
            if request.windows(4).any(|v| v == b"\r\n\r\n") {
                let is_post = request.starts_with(b"POST ");
                if !is_post || request.ends_with(b"List-Unsubscribe=One-Click") {
                    break;
                }
            }
        }
        let _ = stream.write_all(&response).await;
        String::from_utf8(request).unwrap()
    });
    (address, job)
}

// This private test client pins a synthetic public name to the local harness.
// Production has no endpoint override, certificate bypass or private-IP switch.
fn test_client(address: SocketAddr) -> Client {
    client_builder()
        .resolve("sender.example", address)
        .build()
        .unwrap()
}

#[tokio::test]
async fn forbidden_literal_never_connects() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    assert!(fetch(&url, 100).await.is_err());
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn connection_is_pinned_and_original_host_is_preserved() {
    let (address, server) = server(
        b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 8\r\n\r\n\x89PNG\r\n\x1a\n"
            .to_vec(),
    )
    .await;
    let response = execute(
        &test_client(address),
        parse_url("http://sender.example/image", false).unwrap(),
        Method::GET,
        MAX_IMAGE,
        DEADLINE,
    )
    .await
    .unwrap();
    assert_eq!(
        image_data(response).unwrap(),
        "data:image/png;base64,iVBORw0KGgo="
    );
    let request = server.await.unwrap();
    assert!(request.to_lowercase().contains("host: sender.example\r\n"));
    assert!(!request.to_lowercase().contains("authorization:"));
}

#[tokio::test]
async fn post_is_fixed_and_redirect_destination_receives_nothing() {
    let destination = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let reply = format!(
        "HTTP/1.1 302 Found\r\nLocation: http://{}/landed\r\nContent-Length: 0\r\n\r\n",
        destination.local_addr().unwrap()
    );
    let (address, server) = server(reply.into_bytes()).await;
    let response = execute(
        &test_client(address),
        parse_url("http://sender.example/unsubscribe", false).unwrap(),
        Method::POST,
        0,
        DEADLINE,
    )
    .await
    .unwrap();
    assert_eq!(response.status, 302);
    let request = server.await.unwrap();
    assert!(request.ends_with("\r\n\r\nList-Unsubscribe=One-Click"));
    assert!(
        request
            .to_lowercase()
            .contains("content-type: application/x-www-form-urlencoded\r\n")
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), destination.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn streamed_size_encoding_and_image_type_are_bounded() {
    for reply in [
        "HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\n",
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n9\r\n123456789\r\n0\r\n\r\n",
        "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 0\r\n\r\n",
    ] {
        let (address, server) = server(reply.as_bytes().to_vec()).await;
        assert!(
            execute(
                &test_client(address),
                parse_url("http://sender.example/", false).unwrap(),
                Method::GET,
                8,
                DEADLINE
            )
            .await
            .is_err()
        );
        server.await.unwrap();
    }
    assert!(
        image_data(Response {
            status: 200,
            content_type: "image/png".into(),
            body: b"<svg><image href='http://127.0.0.1/'/></svg>".to_vec()
        })
        .is_err()
    );
    assert!(
        image_data(Response {
            status: 200,
            content_type: "text/html".into(),
            body: b"\x89PNG\r\n\x1a\n".to_vec()
        })
        .is_err()
    );
}

#[tokio::test]
async fn deadline_includes_waiting_for_headers() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = test_client(listener.local_addr().unwrap());
    let blocked = tokio::spawn(async move {
        let (_stream, _) = listener.accept().await.unwrap();
        std::future::pending::<()>().await;
    });
    let result = execute(
        &client,
        parse_url("http://sender.example/", false).unwrap(),
        Method::GET,
        8,
        Duration::from_millis(50),
    )
    .await;
    assert_eq!(result.err(), Some("public_http_timeout"));
    blocked.abort();
}

#[tokio::test]
async fn pending_dns_is_inside_the_whole_request_deadline() {
    struct Pending;
    impl Resolve for Pending {
        fn resolve(&self, _: Name) -> Resolving {
            Box::pin(std::future::pending())
        }
    }
    let client = client_builder()
        .dns_resolver(Arc::new(Pending))
        .build()
        .unwrap();
    let result = execute(
        &client,
        parse_url("http://sender.example/", false).unwrap(),
        Method::GET,
        8,
        Duration::from_millis(50),
    )
    .await;
    assert_eq!(result.err(), Some("public_http_timeout"));
}

#[tokio::test]
async fn tls_verifies_issuer_and_original_hostname_before_http() {
    use std::io::{BufRead, BufReader};
    let mut peer = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/providers/gmail_http_tls_test.py"
        ))
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = BufReader::new(peer.stdout.take().unwrap());
    let mut port = String::new();
    output.read_line(&mut port).unwrap();
    let address: SocketAddr = format!("127.0.0.1:{}", port.trim()).parse().unwrap();
    let mut certificate = String::new();
    output.read_line(&mut certificate).unwrap();
    let certificate =
        reqwest::Certificate::from_pem(&std::fs::read(certificate.trim()).unwrap()).unwrap();
    let trusted = client_builder()
        .resolve("sender.example", address)
        .add_root_certificate(certificate)
        .build()
        .unwrap();
    // Both requests connect to the pinned address, retaining sender.example as
    // the TLS name. Trusting the issuer alone must not trust its localhost name.
    for client in [test_client(address), trusted] {
        let result = execute(
            &client,
            parse_url("https://sender.example/unsubscribe", true).unwrap(),
            Method::POST,
            0,
            DEADLINE,
        )
        .await;
        assert!(result.is_err());
        let mut report = String::new();
        output.read_line(&mut report).unwrap();
        assert_eq!(report.trim(), "tls-refused-no-http");
    }
    assert!(peer.wait().unwrap().success());
}

fn gradient(width: u32, height: u32, alpha: bool) -> image::DynamicImage {
    let pixel = |x: u32, y: u32| {
        let a = if alpha && x < width / 2 { 0 } else { 255 };
        [
            (x * 255 / width) as u8,
            (y * 255 / height) as u8,
            ((x ^ y) & 0xff) as u8,
            a,
        ]
    };
    if alpha {
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(width, height, |x, y| {
            image::Rgba(pixel(x, y))
        }))
    } else {
        image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(width, height, |x, y| {
            let [r, g, b, _] = pixel(x, y);
            image::Rgb([r, g, b])
        }))
    }
}

fn encoded(picture: &image::DynamicImage, format: image::ImageFormat) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    picture.write_to(&mut out, format).unwrap();
    out.into_inner()
}

fn served(mime: &str, body: Vec<u8>) -> Result<String, &'static str> {
    image_data(Response {
        status: 200,
        content_type: mime.into(),
        body,
    })
}

fn shown(uri: &str) -> (String, image::DynamicImage) {
    let (head, data) = uri.split_once(";base64,").unwrap();
    let bytes = STANDARD.decode(data).unwrap();
    let picture = image::load_from_memory(&bytes).unwrap();
    (head.trim_start_matches("data:").to_string(), picture)
}

#[test]
fn oversized_png_is_shrunk_to_the_reader_width_and_stays_a_png() {
    let original = encoded(&gradient(3000, 2000, false), image::ImageFormat::Png);
    let (mime, picture) = shown(&served("image/png", original).unwrap());
    assert_eq!(mime, "image/png");
    assert_eq!((picture.width(), picture.height()), (1600, 1067));
}

#[test]
fn transparency_survives_shrinking() {
    let original = encoded(&gradient(3000, 1500, true), image::ImageFormat::Png);
    let (_, picture) = shown(&served("image/png", original).unwrap());
    let picture = picture.to_rgba8();
    assert_eq!((picture.width(), picture.height()), (1600, 800));
    assert_eq!(picture.get_pixel(10, 400).0[3], 0);
    assert_eq!(picture.get_pixel(1590, 400).0[3], 255);
}

#[test]
fn oversized_jpeg_is_shrunk_and_stays_a_jpeg() {
    let original = encoded(&gradient(3200, 2400, false), image::ImageFormat::Jpeg);
    let (mime, picture) = shown(&served("image/jpeg", original).unwrap());
    assert_eq!(mime, "image/jpeg");
    assert_eq!((picture.width(), picture.height()), (1600, 1200));
}

#[test]
fn tall_images_keep_their_width_until_the_area_limit() {
    let original = encoded(&gradient(1000, 7000, false), image::ImageFormat::Png);
    let (_, picture) = shown(&served("image/png", original).unwrap());
    // Sides are rounded, so the area may overshoot the 4 MP target by a hair.
    let area = u64::from(picture.width()) * u64::from(picture.height());
    assert!((3_900_000..=4_010_000).contains(&area));
    assert!(picture.width() >= 700 && picture.height() >= 5000);
}

#[test]
fn camera_rotation_is_applied_before_sizing() {
    let mut original = std::io::Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut original, 90);
    // A little-endian EXIF block whose only tag is Orientation = 6 (rotate 90).
    let exif = [
        b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
    ];
    image::ImageEncoder::set_exif_metadata(&mut encoder, exif.to_vec()).unwrap();
    gradient(3200, 2400, false)
        .write_with_encoder(encoder)
        .unwrap();
    let (_, picture) = shown(&served("image/jpeg", original.into_inner()).unwrap());
    // Shown 2400 wide by 3200 tall, so the width limit applies to the 2400.
    assert_eq!((picture.width(), picture.height()), (1600, 2133));
    // The source's red ramps left to right; turned a quarter, it ramps down.
    let picture = picture.to_rgb8();
    assert!(picture.get_pixel(800, 100).0[0] < 40);
    assert!(picture.get_pixel(800, 2000).0[0] > 215);
    assert!(picture.get_pixel(100, 1000).0[0].abs_diff(picture.get_pixel(1500, 1000).0[0]) < 20);
}

#[test]
fn images_within_the_keep_limits_pass_through_byte_for_byte() {
    for (width, height) in [(400, 300), (2400, 1200), (1800, 3300)] {
        let original = encoded(&gradient(width, height, false), image::ImageFormat::Png);
        let expected = format!("data:image/png;base64,{}", STANDARD.encode(&original));
        assert_eq!(served("image/png", original).unwrap(), expected);
    }
}

#[test]
fn a_shrunk_image_is_prepared_once_and_reused() {
    let original = encoded(&gradient(2500, 1700, false), image::ImageFormat::Png);
    let first = downscale::prepare("image/png", &original).unwrap();
    let second = downscale::prepare("image/png", &original).unwrap();
    match (first, second) {
        (downscale::Prepared::Smaller(a), downscale::Prepared::Smaller(b)) => {
            assert!(std::sync::Arc::ptr_eq(&a, &b));
        }
        _ => panic!("the oversized image was not shrunk"),
    }
}

fn png_chunk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut chunk = kind.to_vec();
    chunk.extend(body);
    let mut crc = u32::MAX;
    for byte in &chunk {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                0xedb8_8320 ^ (crc >> 1)
            } else {
                crc >> 1
            };
        }
    }
    let mut out = (body.len() as u32).to_be_bytes().to_vec();
    out.extend(chunk);
    out.extend((!crc).to_be_bytes());
    out
}

// A PNG that declares its size and then stops, as a decompression bomb or a
// cut-off download would.
fn png_header(width: u32, height: u32, depth: u8, color: u8) -> Vec<u8> {
    let mut ihdr = width.to_be_bytes().to_vec();
    ihdr.extend(height.to_be_bytes());
    ihdr.extend([depth, color, 0, 0, 0]);
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    out.extend(png_chunk(b"IHDR", &ihdr));
    out.extend(png_chunk(b"IDAT", &[]));
    out
}

// An 8-bit RGB PNG stored with Adam7 interlacing, which the `image` encoder
// cannot write. The decoder assembles such a file in a second full-size
// buffer, which is what the guard prices at twice the decoded size.
fn interlaced_png(width: u32, height: u32) -> Vec<u8> {
    use std::io::Write;
    const PASSES: [(u32, u32, u32, u32); 7] = [
        (0, 0, 8, 8),
        (4, 0, 8, 8),
        (0, 4, 4, 8),
        (2, 0, 4, 4),
        (0, 2, 2, 4),
        (1, 0, 2, 2),
        (0, 1, 1, 2),
    ];
    let mut raw = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut line = Vec::new();
    for (x0, y0, dx, dy) in PASSES {
        if x0 >= width || y0 >= height {
            continue;
        }
        for y in (y0..height).step_by(dy as usize) {
            line.clear();
            line.push(0);
            for x in (x0..width).step_by(dx as usize) {
                line.extend([
                    (x * 255 / width) as u8,
                    (y * 255 / height) as u8,
                    ((x ^ y) & 0xff) as u8,
                ]);
            }
            raw.write_all(&line).unwrap();
        }
    }
    let mut ihdr = width.to_be_bytes().to_vec();
    ihdr.extend(height.to_be_bytes());
    ihdr.extend([8, 2, 0, 0, 1]);
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    out.extend(png_chunk(b"IHDR", &ihdr));
    out.extend(png_chunk(b"IDAT", &raw.finish().unwrap()));
    out.extend(png_chunk(b"IEND", &[]));
    out
}

#[test]
fn an_image_too_large_to_decode_within_the_limit_is_refused() {
    assert_eq!(
        served("image/png", png_header(20_000, 20_000, 8, 2)),
        Err("public_image_refused")
    );
}

#[test]
fn an_image_that_will_not_decode_passes_through_and_is_not_decoded_again() {
    let truncated = png_header(3000, 2000, 8, 2);
    let expected = format!("data:image/png;base64,{}", STANDARD.encode(&truncated));
    assert_eq!(served("image/png", truncated.clone()).unwrap(), expected);
    let key: [u8; 32] = sha2::Sha256::digest(&truncated).into();
    assert!(matches!(
        downscale::cache().lock().unwrap().get(&key),
        Some(downscale::Entry::Keep)
    ));
    assert_eq!(served("image/png", truncated).unwrap(), expected);
}

#[test]
fn the_prepared_cache_evicts_the_least_recently_used_first() {
    let mut cache = downscale::Cache::default();
    let chunk = std::sync::Arc::new(vec![0u8; 1024 * 1024]);
    for n in 0..30u8 {
        cache.put([n; 32], downscale::Entry::Smaller(chunk.clone()));
    }
    assert!(cache.get(&[0; 32]).is_some());
    for n in 30..34u8 {
        cache.put([n; 32], downscale::Entry::Smaller(chunk.clone()));
    }
    assert!(cache.get(&[0; 32]).is_some(), "a recent hit is kept");
    assert!(
        cache.get(&[1; 32]).is_none(),
        "the oldest unused is evicted"
    );
    assert!(cache.get(&[33; 32]).is_some());
}

const BUDGET: u64 = 512 * 1024 * 1024;

// Counts heap use on the one thread that switched it on, so concurrent tests
// do not disturb a measurement.
mod counting {
    use std::{
        alloc::{GlobalAlloc, Layout, System},
        cell::Cell,
    };

    thread_local! {
        static ON: Cell<bool> = const { Cell::new(false) };
        static LIVE: Cell<usize> = const { Cell::new(0) };
        static PEAK: Cell<usize> = const { Cell::new(0) };
    }

    pub struct Counting;

    fn grow(by: usize) {
        if ON.with(Cell::get) {
            let live = LIVE.with(|c| c.get() + by);
            LIVE.with(|c| c.set(live));
            PEAK.with(|c| c.set(c.get().max(live)));
        }
    }

    fn shrink(by: usize) {
        if ON.with(Cell::get) {
            LIVE.with(|c| c.set(c.get().saturating_sub(by)));
        }
    }

    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            grow(layout.size());
            unsafe { System.alloc(layout) }
        }
        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            grow(layout.size());
            unsafe { System.alloc_zeroed(layout) }
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            shrink(layout.size());
            unsafe { System.dealloc(ptr, layout) }
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new: usize) -> *mut u8 {
            if new > layout.size() {
                grow(new - layout.size());
            } else {
                shrink(layout.size() - new);
            }
            unsafe { System.realloc(ptr, layout, new) }
        }
    }

    /// The most heap `work` held at once, in bytes.
    pub fn peak_of<T>(work: impl FnOnce() -> T) -> (T, usize) {
        LIVE.with(|c| c.set(0));
        PEAK.with(|c| c.set(0));
        ON.with(|c| c.set(true));
        let out = work();
        ON.with(|c| c.set(false));
        (out, PEAK.with(Cell::get))
    }
}

#[global_allocator]
static ALLOCATOR: counting::Counting = counting::Counting;

#[test]
fn an_over_budget_image_is_refused_before_anything_is_allocated() {
    // 81 MP of 16-bit RGBA, and 96 MP of 8-bit RGB (under the pixel limit, over
    // the budget once the resize's working memory is counted): a few dozen
    // bytes of file each.
    for bomb in [
        png_header(9000, 9000, 16, 6),
        png_header(12_000, 8000, 8, 2),
    ] {
        let (outcome, peak) = counting::peak_of(|| downscale::prepare("image/png", &bomb));
        assert!(matches!(outcome, Err("public_image_refused")));
        assert!(peak < 4 * 1024 * 1024, "refusal allocated {peak} bytes");
    }
}

#[test]
fn an_accepted_image_never_exceeds_the_allocation_budget() {
    // Real work with the locked `image` version: the peak of the whole decode,
    // resize and encode has to stay inside the budget for every image the guard
    // accepts, for each sample type and shape it prices from the header.
    for (picture, format) in [
        (gradient(3000, 2400, false), image::ImageFormat::Jpeg),
        (gradient(3000, 2400, false), image::ImageFormat::Png),
        (gradient(3000, 2400, true), image::ImageFormat::Png),
        (
            image::DynamicImage::ImageRgba16(image::ImageBuffer::from_fn(2800, 2600, |x, y| {
                image::Rgba([(x * 20) as u16, (y * 20) as u16, 9, 50_000])
            })),
            image::ImageFormat::Png,
        ),
        // Tall: the resize intermediate is as wide as the source.
        (
            image::DynamicImage::ImageRgba16(image::ImageBuffer::from_fn(1600, 18_000, |x, y| {
                image::Rgba([(x * 40) as u16, (y * 3) as u16, 9, 50_000])
            })),
            image::ImageFormat::Png,
        ),
    ] {
        let mime = if format == image::ImageFormat::Jpeg {
            "image/jpeg"
        } else {
            "image/png"
        };
        let bytes = encoded(&picture, format);
        let (outcome, peak) = counting::peak_of(|| downscale::prepare(mime, &bytes));
        assert!(matches!(outcome, Ok(downscale::Prepared::Smaller(_))));
        assert!(
            (peak as u64) <= BUDGET,
            "{mime} {}x{}: peak {peak} bytes, budget {BUDGET}",
            picture.width(),
            picture.height()
        );
    }
}

#[test]
fn an_accepted_interlaced_png_never_exceeds_the_allocation_budget() {
    // The decoder assembles an interlaced file in a second full-size buffer.
    let bytes = interlaced_png(7200, 7200);
    let (outcome, peak) = counting::peak_of(|| downscale::prepare("image/png", &bytes));
    assert!(matches!(outcome, Ok(downscale::Prepared::Smaller(_))));
    assert!(
        (peak as u64) <= BUDGET,
        "interlaced 7200x7200: peak {peak} bytes, budget {BUDGET}"
    );
}

// A progressive JPEG keeps a coefficient for every component of every pixel.
fn progressive_jpeg(picture: &image::RgbImage) -> Vec<u8> {
    let mut out = Vec::new();
    let mut encoder = jpeg_encoder::Encoder::new(&mut out, 90);
    encoder.set_progressive(true);
    encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_4_4);
    encoder
        .encode(
            picture.as_raw(),
            picture.width() as u16,
            picture.height() as u16,
            jpeg_encoder::ColorType::Rgb,
        )
        .unwrap();
    out
}

#[test]
fn an_accepted_progressive_jpeg_never_exceeds_the_allocation_budget() {
    let picture = gradient(4000, 3000, false).to_rgb8();
    let bytes = progressive_jpeg(&picture);
    assert!(bytes.windows(2).any(|pair| pair == [0xff, 0xc2]));
    let (outcome, peak) = counting::peak_of(|| downscale::prepare("image/jpeg", &bytes));
    assert!(matches!(outcome, Ok(downscale::Prepared::Smaller(_))));
    assert!(
        (peak as u64) <= BUDGET,
        "progressive 4000x3000: peak {peak} bytes, budget {BUDGET}"
    );
}

#[test]
fn images_whose_peak_passes_the_budget_are_refused_before_decoding() {
    // Cases found over 512 MiB with a guard that priced the resize and the
    // coefficients by pixel count alone: a tall 16-bit PNG, whose resize
    // intermediate is as wide as the source, and a large progressive JPEG.
    // Only the header is real; refusal must not decode anything.
    let mut progressive = progressive_jpeg(&gradient(64, 64, false).to_rgb8());
    let at = progressive
        .windows(2)
        .position(|pair| pair == [0xff, 0xc2])
        .unwrap();
    progressive[at + 5..at + 9].copy_from_slice(&[0x20, 0x00, 0x20, 0x00]);
    for (mime, bomb) in [
        ("image/png", png_header(1600, 26_500, 16, 6)),
        ("image/jpeg", progressive),
    ] {
        let (outcome, peak) = counting::peak_of(|| downscale::prepare(mime, &bomb));
        assert!(matches!(outcome, Err("public_image_refused")), "{mime}");
        assert!(
            peak < 4 * 1024 * 1024,
            "{mime}: refusal allocated {peak} bytes"
        );
    }
}
