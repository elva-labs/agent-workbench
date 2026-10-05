/**
 * A short, quiet chime: two soft sine notes, a fourth apart, made in the
 * window rather than played from a file.
 *
 * A webview may hold back sound that nothing the user did asked for, so the
 * audio context is made on the user's first press in the window, which lets
 * it play later while the window is in the background.
 */

/** The notes, in hertz, and how far apart they start, in seconds. */
const NOTES = [659.25, 880];
const STEP = 0.11;
/** How loud each note is at its peak, out of one. */
const PEAK = 0.05;
/** How long each note rings out, in seconds. */
const RING = 0.6;

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (context !== null) return context;
  try {
    context = new AudioContext();
  } catch {
    // No audio here: the chime is silent.
  }
  return context;
}

/** Makes the audio context on the user's first press in the window.
    Returns a stop function. */
export function primeChime(target: Window = window): () => void {
  const prime = () => {
    void audio()?.resume().catch(() => {});
    stop();
  };
  const stop = () => {
    target.removeEventListener("pointerdown", prime, true);
    target.removeEventListener("keydown", prime, true);
  };
  target.addEventListener("pointerdown", prime, true);
  target.addEventListener("keydown", prime, true);
  return stop;
}

export function playChime() {
  const sound = audio();
  if (sound === null) return;
  void sound.resume().catch(() => {});
  const now = sound.currentTime;
  NOTES.forEach((frequency, index) => {
    const start = now + index * STEP;
    const note = sound.createOscillator();
    note.type = "sine";
    note.frequency.value = frequency;
    const level = sound.createGain();
    level.gain.setValueAtTime(0, start);
    level.gain.linearRampToValueAtTime(PEAK, start + 0.01);
    level.gain.exponentialRampToValueAtTime(0.0001, start + RING);
    note.connect(level).connect(sound.destination);
    note.start(start);
    note.stop(start + RING + 0.05);
  });
}
