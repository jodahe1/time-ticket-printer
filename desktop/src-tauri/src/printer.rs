// Silent printing, ported from the browser print service (agent.ps1):
//  - thermal / receipt printers get the receipt image as ESC/POS raster data
//    (sent RAW, so no dialog and no driver margins) followed by an auto-cut
//  - other printers (office / laser) get the same image through normal
//    Windows printing
//  - a USB printer moved to another socket is found again automatically

use serde::{Deserialize, Serialize};

/// Receipt image: 1 bit per pixel, rows packed MSB first, 1 = black.
#[derive(Deserialize)]
pub struct Raster {
  pub width: u32,
  pub height: u32,
  pub data: Vec<u8>,
}

impl Raster {
  pub fn bytes_per_row(&self) -> usize {
    (self.width as usize).div_ceil(8)
  }

  fn check(&self) -> Result<(), String> {
    if self.width == 0 || self.height == 0 || self.data.len() != self.bytes_per_row() * self.height as usize {
      return Err("Invalid receipt image".into());
    }
    Ok(())
  }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
  pub name: String,
  pub port: String,
  pub driver: String,
  pub connected: bool,
  pub is_default: bool,
}

/// ESC/POS raster image with feed (and cut) at the end.
pub fn to_escpos(raster: &Raster, cut: bool) -> Vec<u8> {
  let bpr = raster.bytes_per_row();
  let mut out = Vec::with_capacity(raster.data.len() + 64);
  out.extend_from_slice(&[0x1B, 0x40]); // ESC @  initialise
  const BAND: usize = 128; // keep each raster block small
  let h = raster.height as usize;
  let mut y0 = 0;
  while y0 < h {
    let bh = BAND.min(h - y0);
    out.extend_from_slice(&[
      0x1D, 0x76, 0x30, 0x00, // GS v 0  raster image
      (bpr & 0xFF) as u8,
      (bpr >> 8) as u8,
      (bh & 0xFF) as u8,
      (bh >> 8) as u8,
    ]);
    out.extend_from_slice(&raster.data[y0 * bpr..(y0 + bh) * bpr]);
    y0 += bh;
  }
  out.extend_from_slice(&[0x1B, 0x64, 0x04]); // ESC d 4  feed past the tear bar
  if cut {
    out.extend_from_slice(&[0x1D, 0x56, 0x42, 0x00]); // GS V 66 0  feed to cutter and cut
  }
  out
}

#[cfg(windows)]
mod win {
  use super::*;
  use windows::core::{BOOL, HSTRING, PCWSTR, PWSTR};
  use windows::Win32::Devices::DeviceAndDriverInstallation::*;
  use windows::Win32::Graphics::Gdi::*;
  use windows::Win32::Graphics::Printing::*;
  use windows::Win32::Storage::Xps::*;

  fn pwstr_to_string(p: PWSTR) -> String {
    if p.is_null() {
      String::new()
    } else {
      unsafe { p.to_string().unwrap_or_default() }
    }
  }

  pub fn default_printer() -> String {
    unsafe {
      let mut len = 0u32;
      let _ = GetDefaultPrinterW(None, &mut len);
      if len == 0 {
        return String::new();
      }
      let mut buf = vec![0u16; len as usize];
      if !GetDefaultPrinterW(Some(PWSTR(buf.as_mut_ptr())), &mut len).as_bool() {
        return String::new();
      }
      String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(buf.len())])
    }
  }

  /// USB ports that currently have a printer plugged in (e.g. "USB003")
  pub fn connected_usb_ports() -> Vec<String> {
    let mut ports = Vec::new();
    unsafe {
      let Ok(set) = SetupDiGetClassDevsW(None, &HSTRING::from("USBPRINT"), None, DIGCF_PRESENT | DIGCF_ALLCLASSES) else {
        return ports;
      };
      let mut i = 0;
      loop {
        let mut info = SP_DEVINFO_DATA { cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32, ..Default::default() };
        if SetupDiEnumDeviceInfo(set, i, &mut info).is_err() {
          break;
        }
        i += 1;
        let mut buf = [0u16; 512];
        if SetupDiGetDeviceInstanceIdW(set, &info, Some(&mut buf), None).is_ok() {
          let id = String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(0)]).to_uppercase();
          if let Some(pos) = id.rfind("USB") {
            let tail = &id[pos..];
            if tail.len() > 3 && tail[3..].chars().all(|c| c.is_ascii_digit()) {
              ports.push(tail.to_string());
            }
          }
        }
      }
      let _ = SetupDiDestroyDeviceInfoList(set);
    }
    ports
  }

  pub fn list_printers() -> Vec<PrinterInfo> {
    let default = default_printer();
    let connected = connected_usb_ports();
    let mut printers = Vec::new();
    unsafe {
      let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
      let (mut needed, mut count) = (0u32, 0u32);
      let _ = EnumPrintersW(flags, PCWSTR::null(), 2, None, &mut needed, &mut count);
      if needed == 0 {
        return printers;
      }
      // u64 backing keeps the PRINTER_INFO_2W array aligned
      let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
      let bytes = std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, needed as usize);
      if EnumPrintersW(flags, PCWSTR::null(), 2, Some(bytes), &mut needed, &mut count).is_err() {
        return printers;
      }
      let items = std::slice::from_raw_parts(buf.as_ptr() as *const PRINTER_INFO_2W, count as usize);
      for p in items {
        let name = pwstr_to_string(p.pPrinterName);
        let port = pwstr_to_string(p.pPortName);
        printers.push(PrinterInfo {
          connected: connected.iter().any(|c| c.eq_ignore_ascii_case(&port)),
          is_default: name == default,
          driver: pwstr_to_string(p.pDriverName),
          name,
          port,
        });
      }
    }
    printers
  }

  /// Windows creates a new "XP-58 (copy N)" queue each time a USB printer is
  /// plugged into another socket. If the chosen queue's USB port is empty, use
  /// a queue with the same driver on the port where the printer is now.
  pub fn resolve_printer(name: &str) -> String {
    if name.is_empty() {
      return default_printer();
    }
    let all = list_printers();
    let Some(chosen) = all.iter().find(|p| p.name == name) else { return name.into() };
    if !chosen.port.to_uppercase().starts_with("USB") || chosen.connected {
      return name.into();
    }
    all
      .iter()
      .find(|p| p.connected && p.driver == chosen.driver)
      .map(|p| p.name.clone())
      .unwrap_or_else(|| name.into())
  }

  fn printer_dc(name: &str) -> Result<HDC, String> {
    let dc = unsafe { CreateDCW(&HSTRING::from("WINSPOOL"), &HSTRING::from(name), PCWSTR::null(), None) };
    if dc.is_invalid() {
      return Err(format!("Printer '{name}' was not found. Choose another printer in the settings."));
    }
    Ok(dc)
  }

  /// Receipt (roll) printers report paper 80 mm wide or narrower
  pub fn is_receipt_printer(name: &str) -> bool {
    let Ok(dc) = printer_dc(name) else { return false };
    unsafe {
      let width = GetDeviceCaps(Some(dc), PHYSICALWIDTH);
      let dpi = GetDeviceCaps(Some(dc), LOGPIXELSX);
      let _ = DeleteDC(dc);
      dpi > 0 && width > 0 && (width as f64 / dpi as f64) <= 3.2
    }
  }

  /// Sends bytes straight to the printer queue (no driver rendering).
  pub fn send_raw(printer: &str, doc_name: &str, data: &[u8]) -> Result<(), String> {
    unsafe {
      let mut handle = PRINTER_HANDLE::default();
      OpenPrinterW(&HSTRING::from(printer), &mut handle, None)
        .map_err(|e| format!("Cannot open printer '{printer}': {}", e.message()))?;
      let doc = HSTRING::from(doc_name);
      let datatype = HSTRING::from("RAW");
      let info = DOC_INFO_1W {
        pDocName: PWSTR(doc.as_ptr() as *mut u16),
        pOutputFile: PWSTR::null(),
        pDatatype: PWSTR(datatype.as_ptr() as *mut u16),
      };
      let result = (|| {
        if StartDocPrinterW(handle, 1, &info) == 0 {
          return Err(format!("Printer '{printer}' refused the job: {}", windows::core::Error::from_thread().message()));
        }
        let _ = StartPagePrinter(handle);
        let mut written = 0u32;
        let ok: BOOL = WritePrinter(handle, data.as_ptr() as _, data.len() as u32, &mut written);
        let _ = EndPagePrinter(handle);
        let _ = EndDocPrinter(handle);
        if !ok.as_bool() {
          return Err(format!("Printing failed: {}", windows::core::Error::from_thread().message()));
        }
        Ok(())
      })();
      let _ = ClosePrinter(handle);
      result
    }
  }

  #[repr(C)]
  struct MonoBitmapInfo {
    header: BITMAPINFOHEADER,
    colors: [RGBQUAD; 2],
  }

  /// Normal Windows printing of the receipt image (office / laser printers).
  pub fn print_image(printer: &str, doc_name: &str, raster: &Raster, max_width_mm: f64) -> Result<(), String> {
    let dc = printer_dc(printer)?;
    let result = unsafe { print_image_on(dc, doc_name, raster, max_width_mm) };
    unsafe {
      let _ = DeleteDC(dc);
    }
    result
  }

  unsafe fn print_image_on(dc: HDC, doc_name: &str, raster: &Raster, max_width_mm: f64) -> Result<(), String> {
    let dpi_x = GetDeviceCaps(Some(dc), LOGPIXELSX).max(1) as f64;
    let dpi_y = GetDeviceCaps(Some(dc), LOGPIXELSY).max(1) as f64;
    let printable_mm = GetDeviceCaps(Some(dc), HORZRES) as f64 / dpi_x * 25.4;

    // Fit the receipt to the paper: narrow rolls vs. A4 pages
    let margin_mm = if printable_mm < 70.0 { 1.0 } else { 5.0 };
    let width_mm = max_width_mm.min(printable_mm - 2.0 * margin_mm);
    let dest_w = (width_mm / 25.4 * dpi_x).round() as i32;
    let dest_h = (width_mm * raster.height as f64 / raster.width as f64 / 25.4 * dpi_y).round() as i32;
    let x = (margin_mm / 25.4 * dpi_x).round() as i32;
    let y = (3.0 / 25.4 * dpi_y).round() as i32;

    // DIB rows must be 4-byte aligned
    let src_bpr = raster.bytes_per_row();
    let dib_bpr = src_bpr.div_ceil(4) * 4;
    let mut bits = vec![0u8; dib_bpr * raster.height as usize];
    for row in 0..raster.height as usize {
      bits[row * dib_bpr..row * dib_bpr + src_bpr].copy_from_slice(&raster.data[row * src_bpr..(row + 1) * src_bpr]);
    }

    let info = MonoBitmapInfo {
      header: BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: raster.width as i32,
        biHeight: -(raster.height as i32), // top-down
        biPlanes: 1,
        biBitCount: 1,
        biCompression: BI_RGB.0,
        ..Default::default()
      },
      colors: [
        RGBQUAD { rgbBlue: 255, rgbGreen: 255, rgbRed: 255, rgbReserved: 0 },
        RGBQUAD { rgbBlue: 0, rgbGreen: 0, rgbRed: 0, rgbReserved: 0 },
      ],
    };

    let doc = HSTRING::from(doc_name);
    let docinfo = DOCINFOW {
      cbSize: std::mem::size_of::<DOCINFOW>() as i32,
      lpszDocName: PCWSTR(doc.as_ptr()),
      ..Default::default()
    };
    if StartDocW(dc, &docinfo) <= 0 {
      return Err(format!("The printer refused the job: {}", windows::core::Error::from_thread().message()));
    }
    StartPage(dc);
    SetStretchBltMode(dc, HALFTONE);
    let lines = StretchDIBits(
      dc,
      x,
      y,
      dest_w,
      dest_h,
      0,
      0,
      raster.width as i32,
      raster.height as i32,
      Some(bits.as_ptr() as _),
      &info as *const MonoBitmapInfo as *const BITMAPINFO,
      DIB_RGB_COLORS,
      SRCCOPY,
    );
    EndPage(dc);
    EndDoc(dc);
    if lines == 0 {
      return Err("Printing failed: the printer did not accept the receipt image".into());
    }
    Ok(())
  }
}

#[cfg(windows)]
pub use win::{default_printer, is_receipt_printer, list_printers, print_image, resolve_printer, send_raw};

#[cfg(not(windows))]
mod other {
  use super::*;
  const MSG: &str = "Printing is only supported on Windows";
  pub fn default_printer() -> String {
    String::new()
  }
  pub fn list_printers() -> Vec<PrinterInfo> {
    Vec::new()
  }
  pub fn resolve_printer(name: &str) -> String {
    name.into()
  }
  pub fn is_receipt_printer(_: &str) -> bool {
    false
  }
  pub fn send_raw(_: &str, _: &str, _: &[u8]) -> Result<(), String> {
    Err(MSG.into())
  }
  pub fn print_image(_: &str, _: &str, _: &Raster, _: f64) -> Result<(), String> {
    Err(MSG.into())
  }
}

#[cfg(not(windows))]
pub use other::*;

/// How a receipt will be printed on the given printer.
pub struct Target {
  pub printer: String,
  pub escpos: bool,
  /// Width of the receipt image in printer dots
  pub dots: u32,
}

pub fn target(printer_name: &str, print_mode: &str, paper_width_mm: u32) -> Target {
  let printer = resolve_printer(printer_name);
  let escpos = match print_mode {
    "escpos" => true,
    "windows" => false,
    _ => is_receipt_printer(&printer),
  };
  // 203 dpi print heads: 58 mm paper = 384 dots, 80 mm paper = 576 dots.
  // Office printers get a sharper image that is scaled to 72 mm.
  let dots = if !escpos {
    1024
  } else if paper_width_mm >= 80 {
    576
  } else {
    384
  };
  Target { printer, escpos, dots }
}

pub fn print(target: &Target, doc_name: &str, raster: &Raster, cut: bool, receipt_width_mm: f64) -> Result<(), String> {
  raster.check()?;
  if target.printer.is_empty() {
    return Err("No printer is installed on this computer.".into());
  }
  if target.escpos {
    send_raw(&target.printer, doc_name, &to_escpos(raster, cut))
  } else {
    print_image(&target.printer, doc_name, raster, receipt_width_mm)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn escpos_bands_and_cut() {
    let raster = Raster { width: 384, height: 200, data: vec![0xFF; 48 * 200] };
    let bytes = to_escpos(&raster, true);
    // init + 2 bands (128 + 72 rows) + feed + cut
    assert_eq!(bytes.len(), 2 + (8 + 48 * 128) + (8 + 48 * 72) + 3 + 4);
    assert_eq!(&bytes[2..10], &[0x1D, 0x76, 0x30, 0x00, 48, 0, 128, 0]);
    assert_eq!(&bytes[bytes.len() - 4..], &[0x1D, 0x56, 0x42, 0x00]);
    assert!(!to_escpos(&raster, false).ends_with(&[0x1D, 0x56, 0x42, 0x00]));
  }

  #[test]
  #[cfg(windows)]
  fn lists_printers_on_this_pc() {
    for p in list_printers() {
      println!("{} | port {} | usb connected {} | default {} | receipt {}", p.name, p.port, p.connected, p.is_default, is_receipt_printer(&p.name));
    }
    println!("default: {}", default_printer());
  }
}
