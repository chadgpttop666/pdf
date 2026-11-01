// Запись голосовой заметки с микрофона: MediaRecorder (Opus) и уровень
// громкости для индикатора — чтобы было видно, что микрофон слышит.

export const MAX_SECONDS = 5 * 60;

function pickType() {
  const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'];
  return types.find((type) => globalThis.MediaRecorder?.isTypeSupported?.(type)) || '';
}

/** Понятное объяснение, почему записать не вышло. */
export function describeMicError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return 'Нет доступа к микрофону — разрешите его читалке (значок микрофона слева в адресной строке)';
  }
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') return 'Микрофон не найден';
  if (error?.name === 'NotReadableError') return 'Микрофон занят другой программой';
  return `Запись не началась: ${error?.message || error}`;
}

/**
 * Начать запись.
 * @param onLimit вызывается, когда запись остановилась сама — дошла до предела
 * @returns {Promise<{ stop(): Promise<{ blob: Blob, seconds: number }>, cancel(): void, level(): number, readonly seconds: number }>}
 */
export async function startRecording({ maxSeconds = MAX_SECONDS, onLimit } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const type = pickType();
  const recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
  const chunks = [];
  recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);

  // Уровень — среднеквадратичное по последним 20 мс.
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const frame = new Float32Array(analyser.fftSize);

  const started = performance.now();
  let finished = null;
  const release = () => {
    clearTimeout(limitTimer);
    for (const track of stream.getTracks()) track.stop();
    context.close().catch(() => {});
  };
  const limitTimer = setTimeout(() => onLimit?.(), maxSeconds * 1000);
  recorder.start(1000);

  return {
    get seconds() {
      return (performance.now() - started) / 1000;
    },
    level() {
      analyser.getFloatTimeDomainData(frame);
      let sum = 0;
      for (const value of frame) sum += value * value;
      return Math.min(1, Math.sqrt(sum / frame.length) * 4);
    },
    stop() {
      finished ??= new Promise((resolve, reject) => {
        const seconds = Math.min(maxSeconds, (performance.now() - started) / 1000);
        recorder.onstop = () => {
          release();
          resolve({ blob: new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' }), seconds });
        };
        recorder.onerror = (event) => {
          release();
          reject(event.error || new Error('Запись прервалась'));
        };
        if (recorder.state === 'inactive') recorder.onstop();
        else recorder.stop();
      });
      return finished;
    },
    cancel() {
      if (recorder.state !== 'inactive') {
        recorder.onstop = null;
        recorder.stop();
      }
      release();
    },
  };
}

/** 0:07, 1:25 */
export function formatSeconds(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
