//! JAWS through its registered automation object `FreedomSci.JawsApi`
//! (`SayString(text, flush)`), only when JAWS itself is running.

use windows::Win32::System::Com::{
    CLSCTX_LOCAL_SERVER, CLSIDFromProgID, CoCreateInstance, DISPATCH_METHOD, DISPPARAMS, IDispatch,
};
use windows::Win32::System::Variant::VARIANT;
use windows::core::{BSTR, GUID, PCWSTR, w};

use crate::window;

fn jaws_running() -> bool {
    window::top_level_windows().into_iter().any(|h| {
        let p = window::process_name(h);
        p == "jfw.exe"
    })
}

pub fn speak(text: &str, flush: bool) -> bool {
    if !jaws_running() {
        return false;
    }
    // SAFETY: standard IDispatch late binding; arguments are passed in reverse order per COM rules.
    unsafe {
        let Ok(clsid) = CLSIDFromProgID(w!("FreedomSci.JawsApi")) else { return false };
        let Ok(api) = CoCreateInstance::<_, IDispatch>(&clsid, None, CLSCTX_LOCAL_SERVER) else {
            return false;
        };
        let name = w!("SayString");
        let mut dispid = 0i32;
        if api.GetIDsOfNames(&GUID::zeroed(), &PCWSTR(name.as_ptr()), 1, 0, &mut dispid).is_err() {
            return false;
        }
        let mut args = [VARIANT::from(flush), VARIANT::from(BSTR::from(text))];
        let params = DISPPARAMS { rgvarg: args.as_mut_ptr(), cArgs: 2, ..Default::default() };
        let mut result = VARIANT::default();
        api.Invoke(dispid, &GUID::zeroed(), 0, DISPATCH_METHOD, &params, Some(&mut result), None, None)
            .is_ok()
    }
}
