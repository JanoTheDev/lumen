//! Claims the real stdout for the protocol writer and points the process's
//! standard output handle and the C runtime's fd 1 at stderr, so `println!`,
//! panics and native libraries (`printf` from a DLL sharing the UCRT, or one
//! loaded later with its own CRT) can never write into the protocol pipe.

use std::fs::File;
use std::io::Write;

#[cfg(windows)]
pub fn claim_stdout() -> Box<dyn Write + Send> {
    use std::os::windows::io::FromRawHandle;
    use windows::Win32::Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE};
    use windows::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE, SetStdHandle};
    use windows::Win32::System::Threading::GetCurrentProcess;

    // SAFETY: standard handle juggling; the duplicate is owned by the returned File.
    unsafe {
        let Ok(stdout) = GetStdHandle(STD_OUTPUT_HANDLE) else {
            return Box::new(std::io::stdout());
        };
        let mut dup = HANDLE::default();
        let process = GetCurrentProcess();
        if stdout.is_invalid()
            || DuplicateHandle(process, stdout, process, &mut dup, 0, false, DUPLICATE_SAME_ACCESS).is_err()
        {
            return Box::new(std::io::stdout());
        }
        if let Ok(stderr) = GetStdHandle(STD_ERROR_HANDLE) {
            let _ = SetStdHandle(STD_OUTPUT_HANDLE, stderr);
        }
        redirect_crt_stdout();
        Box::new(File::from_raw_handle(dup.0))
    }
}

/// The UCRT bound fd 1 to the original stdout handle at startup; rebind it to
/// fd 2 (or NUL without a usable stderr). Closing the old fd 1 only closes the
/// original handle, the protocol writer owns a duplicate.
#[cfg(windows)]
fn redirect_crt_stdout() {
    unsafe extern "C" {
        fn _dup2(from: i32, to: i32) -> i32;
        fn _open(path: *const std::ffi::c_char, flags: i32, ...) -> i32;
        fn _close(fd: i32) -> i32;
    }
    const O_WRONLY: i32 = 0x0001;
    // SAFETY: plain UCRT fd calls on valid descriptors and a NUL-terminated path.
    unsafe {
        if _dup2(2, 1) == 0 {
            return;
        }
        let nul = _open(c"NUL".as_ptr(), O_WRONLY);
        if nul >= 0 && nul != 1 {
            let _ = _dup2(nul, 1);
            let _ = _close(nul);
        }
    }
}

#[cfg(not(windows))]
pub fn claim_stdout() -> Box<dyn Write + Send> {
    Box::new(std::io::stdout())
}
