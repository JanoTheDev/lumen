//! Windows voices as audio data, and the default playback device's mute state.
//!
//! `tts_synthesize` renders text (or SSML) with the WinRT SpeechSynthesizer (the OneCore
//! voices) into a WAV byte buffer and returns it base64-encoded. Nothing is played here:
//! main hands the WAV to the voice renderer's WebAudio player, where Chromium's echo
//! cancellation hears it (barge-in). `audio_output` / `audio_unmute` read and clear the
//! default render endpoint's mute (IAudioEndpointVolume) for the muted-output check.

use serde_json::{Value, json};

use crate::proto::router::CancelToken;
use crate::proto::{AgentError, Args, CmdResult, arg};

/// WinRT SpeakingRate range.
pub const RATE_MIN: f64 = 0.5;
pub const RATE_MAX: f64 = 6.0;
/// WinRT AudioPitch range (1 = the voice's own pitch).
pub const PITCH_MIN: f64 = 0.0;
pub const PITCH_MAX: f64 = 2.0;
pub const MAX_TEXT_CHARS: usize = 20_000;

#[derive(Debug, Clone, PartialEq)]
pub struct VoiceInfo {
    pub id: String,
    pub name: String,
    pub lang: String,
    pub gender: &'static str,
}

impl VoiceInfo {
    pub fn to_json(&self) -> Value {
        json!({"id": self.id, "name": self.name, "lang": self.lang, "gender": self.gender})
    }
}

fn clamp(v: Option<f64>, lo: f64, hi: f64) -> f64 {
    v.filter(|v| v.is_finite()).unwrap_or(1.0).clamp(lo, hi)
}

pub fn clamp_rate(v: Option<f64>) -> f64 {
    clamp(v, RATE_MIN, RATE_MAX)
}

pub fn clamp_pitch(v: Option<f64>) -> f64 {
    clamp(v, PITCH_MIN, PITCH_MAX)
}

/// WinRT VoiceGender (0 male, 1 female).
pub fn gender_name(raw: i32) -> &'static str {
    match raw {
        0 => "male",
        1 => "female",
        _ => "unknown",
    }
}

/// The voice for `want`: its id, else its display name (any case). None = the default voice.
pub fn pick<'a>(voices: &'a [VoiceInfo], want: &str) -> Option<&'a VoiceInfo> {
    let want = want.trim();
    if want.is_empty() {
        return None;
    }
    voices.iter().find(|v| v.id == want).or_else(|| voices.iter().find(|v| v.name.eq_ignore_ascii_case(want)))
}

/// What the synthesizer was last set to, so an unchanged voice or option is not set again.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Applied {
    voice: Option<String>,
    rate: Option<f64>,
    pitch: Option<f64>,
}

impl Applied {
    /// Which of voice, rate and pitch to set; a new voice sets both options again.
    pub fn update(&mut self, voice: &str, rate: f64, pitch: f64) -> (bool, bool, bool) {
        let v = self.voice.as_deref() != Some(voice);
        let r = v || self.rate != Some(rate);
        let p = v || self.pitch != Some(pitch);
        *self = Applied { voice: Some(voice.to_owned()), rate: Some(rate), pitch: Some(pitch) };
        (v, r, p)
    }
}

/// A RIFF/WAVE header, which is what SpeechSynthesisStream holds.
pub fn is_wav(bytes: &[u8]) -> bool {
    bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE"
}

#[derive(Debug, Clone, PartialEq)]
pub struct SynthArgs {
    pub text: String,
    pub voice: String,
    pub rate: f64,
    pub pitch: f64,
    pub ssml: bool,
}

pub fn parse_args(args: &Args) -> Result<SynthArgs, AgentError> {
    let text = arg::str(args, "text")?;
    if text.trim().is_empty() {
        return Err(AgentError::invalid("tts_synthesize needs non-empty text"));
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(AgentError::invalid(format!("text longer than {MAX_TEXT_CHARS} characters")));
    }
    Ok(SynthArgs {
        text: text.to_owned(),
        voice: arg::opt_str(args, "voice")?.unwrap_or("").to_owned(),
        rate: clamp_rate(arg::opt_f64(args, "rate")?),
        pitch: clamp_pitch(arg::opt_f64(args, "pitch")?),
        ssml: arg::opt_bool(args, "ssml")?.unwrap_or(false),
    })
}

pub fn cmd_voices() -> CmdResult {
    let voices = engine::voices()?;
    Ok(json!({"voices": voices.iter().map(VoiceInfo::to_json).collect::<Vec<_>>()}))
}

pub fn cmd_synthesize(args: &Args, token: &CancelToken) -> CmdResult {
    use base64::Engine as _;
    let req = parse_args(args)?;
    token.check()?;
    let (wav, voice) = engine::synthesize(&req, token)?;
    Ok(json!({
        "mime": "audio/wav",
        "data": base64::engine::general_purpose::STANDARD.encode(&wav),
        "bytes": wav.len(),
        "voice": voice,
    }))
}

pub fn cmd_output_state() -> CmdResult {
    let (muted, volume) = engine::output_state()?;
    Ok(json!({"muted": muted, "volume": volume}))
}

pub fn cmd_unmute() -> CmdResult {
    engine::unmute()?;
    Ok(json!({"done": true}))
}

/// Master volume (0..1) of the default playback device, for ducking media while dictating.
pub fn parse_volume(args: &Args) -> Result<f32, AgentError> {
    match arg::opt_f64(args, "level")? {
        Some(v) if v.is_finite() => Ok(v.clamp(0.0, 1.0) as f32),
        _ => Err(AgentError::invalid("audio_set_volume needs a number level (0..1)")),
    }
}

pub fn cmd_set_volume(args: &Args) -> CmdResult {
    let level = parse_volume(args)?;
    engine::set_volume(level)?;
    let (_, volume) = engine::output_state()?;
    Ok(json!({"volume": volume}))
}

#[cfg(windows)]
pub mod engine {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;
    use windows::Media::SpeechSynthesis::{SpeechSynthesizer, VoiceInformation};
    use windows::Storage::Streams::DataReader;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{IMMDeviceEnumerator, MMDeviceEnumerator, eConsole, eRender};
    use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};
    use windows::core::{HSTRING, RuntimeType};
    use windows_future::{AsyncStatus, IAsyncOperation};

    const POLL: Duration = Duration::from_millis(2);

    struct Synth {
        synth: SpeechSynthesizer,
        applied: Applied,
    }

    /// One synthesizer for the process. Calls run on the single speech lane worker, so this
    /// lock is never contended (voice and options are set only when they change).
    static SYNTH: Mutex<Option<Synth>> = Mutex::new(None);

    type VoiceList = Vec<(VoiceInfo, VoiceInformation)>;

    /// The installed voices, read once and again on every `tts_voices` call.
    static VOICES: Mutex<Option<VoiceList>> = Mutex::new(None);

    /// Waits for a WinRT operation, cancelling it when the token fires.
    fn wait<T: RuntimeType + 'static>(op: &IAsyncOperation<T>, token: &CancelToken) -> Result<T, AgentError> {
        while op.Status()? == AsyncStatus::Started {
            if let Err(e) = token.sleep(POLL) {
                let _ = op.Cancel();
                return Err(e);
            }
        }
        Ok(op.GetResults()?)
    }

    fn info(v: &VoiceInformation) -> windows::core::Result<VoiceInfo> {
        Ok(VoiceInfo {
            id: v.Id()?.to_string_lossy(),
            name: v.DisplayName()?.to_string_lossy(),
            lang: v.Language()?.to_string_lossy(),
            gender: gender_name(v.Gender()?.0),
        })
    }

    fn all() -> windows::core::Result<VoiceList> {
        SpeechSynthesizer::AllVoices()?.into_iter().map(|v| Ok((info(&v)?, v))).collect()
    }

    pub fn voices() -> Result<Vec<VoiceInfo>, AgentError> {
        let list = all()?;
        let infos = list.iter().map(|(i, _)| i.clone()).collect();
        *VOICES.lock().unwrap() = Some(list);
        Ok(infos)
    }

    fn installed(want: &str) -> Result<Option<VoiceInformation>, AgentError> {
        let mut cache = VOICES.lock().unwrap();
        if cache.is_none() {
            *cache = Some(all()?);
        }
        let list = cache.as_ref().unwrap();
        let infos: Vec<VoiceInfo> = list.iter().map(|(i, _)| i.clone()).collect();
        Ok(pick(&infos, want).and_then(|p| list.iter().find(|(i, _)| i.id == p.id)).map(|(_, v)| v.clone()))
    }

    /// WAV bytes and the name of the voice used.
    pub fn synthesize(req: &SynthArgs, token: &CancelToken) -> Result<(Vec<u8>, String), AgentError> {
        let mut guard = SYNTH.lock().unwrap();
        if guard.is_none() {
            *guard = Some(Synth { synth: SpeechSynthesizer::new()?, applied: Applied::default() });
        }
        let Synth { synth, applied } = guard.as_mut().unwrap();
        let voice = match installed(&req.voice)? {
            Some(v) => v,
            None => SpeechSynthesizer::DefaultVoice()?,
        };
        let id = voice.Id()?.to_string_lossy();
        let (set_voice, set_rate, set_pitch) = applied.update(&id, req.rate, req.pitch);
        let set = || -> windows::core::Result<()> {
            if set_voice {
                synth.SetVoice(&voice)?;
            }
            if set_rate || set_pitch {
                let opts = synth.Options()?;
                if set_rate {
                    opts.SetSpeakingRate(req.rate)?;
                }
                if set_pitch {
                    opts.SetAudioPitch(req.pitch)?;
                }
            }
            Ok(())
        };
        if let Err(e) = set() {
            *applied = Applied::default();
            return Err(e.into());
        }
        let text = HSTRING::from(req.text.as_str());
        let op = if req.ssml {
            synth.SynthesizeSsmlToStreamAsync(&text)?
        } else {
            synth.SynthesizeTextToStreamAsync(&text)?
        };
        let stream = wait(&op, token)?;
        let size = stream.Size()?;
        let size = u32::try_from(size).map_err(|_| AgentError::internal("synthesized audio too large"))?;
        let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
        let n = wait(&reader.LoadAsync(size)?, token)?;
        let mut buf = vec![0u8; n as usize];
        reader.ReadBytes(&mut buf)?;
        let _ = reader.Close();
        let _ = stream.Close();
        if !is_wav(&buf) {
            return Err(AgentError::internal("synthesizer returned no audio"));
        }
        Ok((buf, voice.DisplayName()?.to_string_lossy()))
    }

    fn endpoint() -> Result<IAudioEndpointVolume, AgentError> {
        // SAFETY: COM is initialised on every lane worker; these are plain COM calls.
        unsafe {
            let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = devices
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|_| AgentError::not_found("no playback device"))?;
            Ok(device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)?)
        }
    }

    pub fn output_state() -> Result<(bool, f32), AgentError> {
        let vol = endpoint()?;
        // SAFETY: valid interface from endpoint().
        unsafe { Ok((vol.GetMute()?.as_bool(), vol.GetMasterVolumeLevelScalar()?)) }
    }

    pub fn unmute() -> Result<(), AgentError> {
        let vol = endpoint()?;
        // SAFETY: valid interface; a null event context is allowed.
        unsafe { Ok(vol.SetMute(false, std::ptr::null())?) }
    }

    pub fn set_volume(level: f32) -> Result<(), AgentError> {
        let vol = endpoint()?;
        // SAFETY: valid interface; a null event context is allowed.
        unsafe { Ok(vol.SetMasterVolumeLevelScalar(level, std::ptr::null())?) }
    }
}

#[cfg(not(windows))]
pub mod engine {
    use super::*;

    fn none<T>() -> Result<T, AgentError> {
        Err(AgentError::unsupported("Windows voices need Windows"))
    }

    pub fn voices() -> Result<Vec<VoiceInfo>, AgentError> {
        none()
    }

    pub fn synthesize(_: &SynthArgs, _: &CancelToken) -> Result<(Vec<u8>, String), AgentError> {
        none()
    }

    pub fn output_state() -> Result<(bool, f32), AgentError> {
        none()
    }

    pub fn unmute() -> Result<(), AgentError> {
        none()
    }

    pub fn set_volume(_: f32) -> Result<(), AgentError> {
        none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(id: &str, name: &str) -> VoiceInfo {
        VoiceInfo { id: id.into(), name: name.into(), lang: "en-US".into(), gender: "female" }
    }

    fn args(v: Value) -> Args {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn clamps() {
        assert_eq!(clamp_rate(Some(0.1)), 0.5);
        assert_eq!(clamp_rate(Some(1.3)), 1.3);
        assert_eq!(clamp_rate(Some(9.0)), 6.0);
        assert_eq!(clamp_rate(Some(f64::NAN)), 1.0);
        assert_eq!(clamp_rate(None), 1.0);
        assert_eq!(clamp_pitch(Some(-1.0)), 0.0);
        assert_eq!(clamp_pitch(Some(5.0)), 2.0);
    }

    #[test]
    fn genders() {
        assert_eq!(gender_name(0), "male");
        assert_eq!(gender_name(1), "female");
        assert_eq!(gender_name(7), "unknown");
    }

    #[test]
    fn picks_by_id_then_name() {
        let list = [v("A", "Microsoft David"), v("B", "Microsoft Zira")];
        assert_eq!(pick(&list, "B").unwrap().id, "B");
        assert_eq!(pick(&list, "microsoft zira").unwrap().id, "B");
        assert!(pick(&list, "").is_none());
        assert!(pick(&list, "alloy").is_none());
    }

    #[test]
    fn applied_reports_only_changes() {
        let mut a = Applied::default();
        assert_eq!(a.update("A", 1.0, 1.0), (true, true, true));
        assert_eq!(a.update("A", 1.0, 1.0), (false, false, false));
        assert_eq!(a.update("B", 1.0, 1.0), (true, true, true));
        assert_eq!(a.update("B", 1.5, 1.0), (false, true, false));
        assert_eq!(a.update("B", 1.5, 0.5), (false, false, true));
    }

    #[test]
    fn wav_header() {
        assert!(is_wav(b"RIFF\x24\0\0\0WAVEfmt "));
        assert!(!is_wav(b"ID3\x04\0\0\0\0\0\0\0\0\0"));
        assert!(!is_wav(b""));
    }

    #[test]
    fn parses_args() {
        let a = parse_args(&args(json!({"text": "Hi", "voice": "x", "rate": 9, "pitch": 1.5, "ssml": true})))
            .unwrap();
        assert_eq!(a, SynthArgs { text: "Hi".into(), voice: "x".into(), rate: 6.0, pitch: 1.5, ssml: true });
        let d = parse_args(&args(json!({"text": "Hi"}))).unwrap();
        assert_eq!((d.rate, d.pitch, d.ssml, d.voice.as_str()), (1.0, 1.0, false, ""));
        assert!(parse_args(&args(json!({"text": "  "}))).is_err());
        assert!(parse_args(&args(json!({}))).is_err());
        assert!(parse_args(&args(json!({"text": "x".repeat(MAX_TEXT_CHARS + 1)}))).is_err());
    }

    #[test]
    fn volume_level_clamped_and_required() {
        assert_eq!(parse_volume(&args(json!({"level": 0.25}))).unwrap(), 0.25);
        assert_eq!(parse_volume(&args(json!({"level": 3}))).unwrap(), 1.0);
        assert_eq!(parse_volume(&args(json!({"level": -1}))).unwrap(), 0.0);
        assert!(parse_volume(&args(json!({}))).is_err());
        assert!(parse_volume(&args(json!({"level": "loud"}))).is_err());
    }

    /// Renders one sentence to bytes (never played). Needs an installed OneCore voice.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn synthesizes_wav_bytes() {
        crate::com_init();
        let req = parse_args(&args(json!({"text": "Hello from Lumen."}))).unwrap();
        let (wav, voice) = engine::synthesize(&req, &CancelToken::new()).unwrap();
        assert!(is_wav(&wav) && wav.len() > 1000, "{} bytes from {voice}", wav.len());
        assert!(!engine::voices().unwrap().is_empty());
    }

    #[test]
    fn cancelled_before_synth() {
        let token = CancelToken::new();
        token.cancel(crate::proto::E_CANCELLED);
        assert!(cmd_synthesize(&args(json!({"text": "Hello."})), &token).is_err());
    }
}
