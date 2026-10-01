//! Claims the real stdout for the protocol writer and points the process's
//! standard output handle at stderr, so `println!`, panics and native
//! libraries loaded later can never write into the protocol pipe.

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
        Box::new(File::from_raw_handle(dup.0))
    }
}

#[cfg(not(windows))]
pub fn claim_stdout() -> Box<dyn Write + Send> {
    Box::new(std::io::stdout())
}
