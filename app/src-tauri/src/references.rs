//! Reference image import: downscale to fit within 1 MP (keeping aspect),
//! re-encode as JPEG q90, or PNG when the image has real transparency.

use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use serde::Serialize;
use std::io::Cursor;
use std::path::{Path, PathBuf};

pub const MAX_PIXELS: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedReference {
    pub ref_id: String,
    pub thumb_path: String,
}

/// Target size fitting within `MAX_PIXELS`, keeping aspect ratio.
pub fn fit_within(w: u32, h: u32) -> (u32, u32) {
    let px = w as u64 * h as u64;
    if px <= MAX_PIXELS {
        return (w, h);
    }
    let scale = (MAX_PIXELS as f64 / px as f64).sqrt();
    let mut nw = ((w as f64 * scale).floor() as u32).max(1);
    let mut nh = ((h as f64 * scale).floor() as u32).max(1);
    while nw as u64 * nh as u64 > MAX_PIXELS {
        if nw >= nh {
            nw -= 1;
        } else {
            nh -= 1;
        }
    }
    (nw, nh)
}

fn has_transparency(img: &DynamicImage) -> bool {
    if !img.color().has_alpha() {
        return false;
    }
    img.to_rgba8().pixels().any(|p| p.0[3] < 255)
}

/// Decode (honouring EXIF orientation), downscale and re-encode.
/// Returns the encoded bytes and the file extension ("jpg" or "png").
pub fn process(bytes: &[u8]) -> Result<(Vec<u8>, &'static str), String> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("Could not read the image: {e}"))?;
    if reader.format().is_none() {
        return Err("Unsupported image format (use PNG, JPEG, WebP, GIF, BMP or TIFF)".into());
    }
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| format!("Could not decode the image: {e}"))?;
    let orientation = decoder.orientation().ok();
    let mut img = DynamicImage::from_decoder(decoder)
        .map_err(|e| format!("Could not decode the image: {e}"))?;
    if let Some(o) = orientation {
        img.apply_orientation(o);
    }
    let (w, h) = fit_within(img.width(), img.height());
    if (w, h) != (img.width(), img.height()) {
        img = img.resize_exact(w, h, image::imageops::FilterType::Lanczos3);
    }
    let mut out = Vec::new();
    if has_transparency(&img) {
        DynamicImage::ImageRgba8(img.to_rgba8())
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .map_err(|e| format!("Could not encode PNG: {e}"))?;
        Ok((out, "png"))
    } else {
        let rgb = img.to_rgb8();
        JpegEncoder::new_with_quality(&mut out, 90)
            .encode_image(&rgb)
            .map_err(|e| format!("Could not encode JPEG: {e}"))?;
        Ok((out, "jpg"))
    }
}

pub fn import_bytes(dir: &Path, bytes: &[u8]) -> Result<ImportedReference, String> {
    let (out, ext) = process(bytes)?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create references folder: {e}"))?;
    let ref_id = uuid::Uuid::new_v4().to_string();
    let path = dir.join(format!("{ref_id}.{ext}"));
    std::fs::write(&path, out).map_err(|e| format!("Could not save the reference: {e}"))?;
    Ok(ImportedReference {
        ref_id,
        thumb_path: path.to_string_lossy().into_owned(),
    })
}

pub fn import_path(dir: &Path, src: &Path) -> Result<ImportedReference, String> {
    let bytes = std::fs::read(src).map_err(|e| format!("Could not open {}: {e}", src.display()))?;
    import_bytes(dir, &bytes)
}

/// Locate a stored reference by id. Ids are UUIDs; anything else is rejected.
pub fn find(dir: &Path, ref_id: &str) -> Result<PathBuf, String> {
    if uuid::Uuid::parse_str(ref_id).is_err() {
        return Err(format!("Invalid reference id \"{ref_id}\""));
    }
    for ext in ["jpg", "png"] {
        let p = dir.join(format!("{ref_id}.{ext}"));
        if p.exists() {
            return Ok(p);
        }
    }
    Err("A reference image is missing; please add it again".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, Rgb, RgbImage, Rgba, RgbaImage};

    fn encode(img: DynamicImage, fmt: ImageFormat) -> Vec<u8> {
        let mut v = Vec::new();
        img.write_to(&mut Cursor::new(&mut v), fmt).unwrap();
        v
    }

    #[test]
    fn fit_math() {
        assert_eq!(fit_within(800, 600), (800, 600));
        let (w, h) = fit_within(4000, 3000);
        assert!(w as u64 * h as u64 <= MAX_PIXELS);
        assert!((w as f64 / h as f64 - 4.0 / 3.0).abs() < 0.01);
        assert!(w as u64 * h as u64 > MAX_PIXELS * 98 / 100);
        let (w, h) = fit_within(10000, 10);
        assert!(w as u64 * h as u64 <= MAX_PIXELS && h >= 1);
    }

    #[test]
    fn large_opaque_png_becomes_small_jpeg() {
        let img = RgbImage::from_fn(3000, 2000, |x, y| {
            Rgb([(x % 256) as u8, (y % 256) as u8, 7])
        });
        let (out, ext) = process(&encode(DynamicImage::ImageRgb8(img), ImageFormat::Png)).unwrap();
        assert_eq!(ext, "jpg");
        let dec = image::load_from_memory(&out).unwrap();
        assert_eq!(image::guess_format(&out).unwrap(), ImageFormat::Jpeg);
        let (w, h) = dec.dimensions();
        assert!(w as u64 * h as u64 <= MAX_PIXELS);
        assert!((w as f64 / h as f64 - 1.5).abs() < 0.01);
    }

    #[test]
    fn transparent_stays_png_and_opaque_rgba_is_jpeg() {
        let t = RgbaImage::from_fn(64, 64, |x, _| Rgba([1, 2, 3, if x < 32 { 0 } else { 255 }]));
        let (out, ext) = process(&encode(DynamicImage::ImageRgba8(t), ImageFormat::Png)).unwrap();
        assert_eq!(ext, "png");
        assert_eq!(
            image::load_from_memory(&out).unwrap().dimensions(),
            (64, 64)
        );

        let o = RgbaImage::from_pixel(64, 64, Rgba([1, 2, 3, 255]));
        let (_, ext) = process(&encode(DynamicImage::ImageRgba8(o), ImageFormat::Png)).unwrap();
        assert_eq!(ext, "jpg");
    }

    #[test]
    fn import_and_find() {
        let dir = tempfile::tempdir().unwrap();
        let img = RgbImage::from_pixel(10, 10, Rgb([5, 5, 5]));
        let r = import_bytes(
            dir.path(),
            &encode(DynamicImage::ImageRgb8(img), ImageFormat::Png),
        )
        .unwrap();
        assert_eq!(
            find(dir.path(), &r.ref_id).unwrap().to_string_lossy(),
            r.thumb_path
        );
        assert!(find(dir.path(), "../etc").is_err());
        assert!(process(b"not an image").is_err());
    }
}
