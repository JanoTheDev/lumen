// The PowerShell side of the Windows voice helper (see win-helper.ts). One JSON request per
// stdin line, one JSON reply per stdout line. Ships with Windows: no install, no key.
//   synth   {id, op, text (base64 UTF-8), voiceId, rate} → {id, ok, wav (base64)}
//   voices  → {id, ok, voices: [{id, name, lang}]}
//   output  → {id, ok, muted, volume}  (default playback device)
//   unmute  → {id, ok}
// The audio endpoint interop is compiled on first use (about a second), not at start.

export const WIN_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' })[0]
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $null = $task.Wait(); $task.Result
}
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$audioReady = $false
function Use-Audio {
  if ($script:audioReady) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace LumenAudio {
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int f(); int g(); int h(); int i();
    int SetMasterVolumeLevelScalar(float level, Guid ctx);
    int j();
    int GetMasterVolumeLevelScalar(out float level);
    int k(); int l(); int m(); int n();
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx);
    int GetMute(out bool mute);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid id, int ctx, IntPtr p, out IAudioEndpointVolume v); }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class DeviceEnumerator { }
  public static class Output {
    static IAudioEndpointVolume Vol() {
      var e = (IMMDeviceEnumerator)new DeviceEnumerator();
      IMMDevice d; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 0, out d));
      var iid = typeof(IAudioEndpointVolume).GUID; IAudioEndpointVolume v;
      Marshal.ThrowExceptionForHR(d.Activate(ref iid, 23, IntPtr.Zero, out v)); return v;
    }
    public static bool Muted() { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
    public static float Volume() { float l; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out l)); return l; }
    public static void Unmute() { Marshal.ThrowExceptionForHR(Vol().SetMute(false, Guid.Empty)); }
  }
}
'@
  $script:audioReady = $true
}
function Reply($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    switch ($req.op) {
      'synth' {
        $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($req.text))
        $voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.Id -eq $req.voiceId } | Select-Object -First 1
        $synth.Voice = if ($voice) { $voice } else { [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::DefaultVoice }
        $synth.Options.SpeakingRate = [double]$req.rate
        $stream = Await ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
        $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
        $n = Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32])
        $buf = New-Object byte[] $n
        $reader.ReadBytes($buf)
        $reader.Dispose(); $stream.Dispose()
        Reply @{ id = $id; ok = $true; wav = [Convert]::ToBase64String($buf) }
      }
      'voices' {
        $list = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object { @{ id = $_.Id; name = $_.DisplayName; lang = $_.Language } })
        Reply @{ id = $id; ok = $true; voices = $list }
      }
      'output' {
        Use-Audio
        Reply @{ id = $id; ok = $true; muted = [LumenAudio.Output]::Muted(); volume = [LumenAudio.Output]::Volume() }
      }
      'unmute' {
        Use-Audio
        [LumenAudio.Output]::Unmute()
        Reply @{ id = $id; ok = $true }
      }
      default { Reply @{ id = $id; ok = $false; error = "unknown op $($req.op)" } }
    }
  } catch {
    Reply @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
}
`
