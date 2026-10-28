// Таймер сна для озвучки: остановить чтение через N минут или в начале
// следующей главы. Последние секунды голос плавно затихает, чтобы не
// разбудить резкой тишиной. Отсчёт идёт с момента, когда чтение началось,
// а не когда таймер выбрали, — иначе он истекал бы, пока книга стоит.

const FADE_MS = 20_000;

export function createSleepTimer({ select, label, chapterEndAfter }) {
  let mode = 'off'; // off | minutes | chapter
  let minutes = 0;
  let until = 0;
  let stopPage = null; // страница, с которой начинается следующая глава
  let armed = false;
  let ticker = 0;

  function describe() {
    if (mode === 'minutes' && until) {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 60_000));
      return `ещё ${left} мин`;
    }
    if (mode === 'chapter' && armed) return stopPage ? `до стр. ${stopPage}` : 'до конца книги';
    return '';
  }

  function render() {
    label.textContent = describe();
  }

  function reset() {
    mode = 'off';
    minutes = 0;
    until = 0;
    stopPage = null;
    armed = false;
    select.value = 'off';
    clearInterval(ticker);
    ticker = 0;
    render();
  }

  function choose(value) {
    reset();
    select.value = value;
    if (value === 'chapter') mode = 'chapter';
    else if (Number(value) > 0) {
      mode = 'minutes';
      minutes = Number(value);
    }
    render();
  }

  select.addEventListener('change', () => choose(select.value));

  return {
    choose,
    reset,
    /** Чтение остановили: выбор сохраняем, но отсчёт начнётся заново при следующем пуске. */
    disarm() {
      armed = false;
      until = 0;
      stopPage = null;
      clearInterval(ticker);
      ticker = 0;
      render();
    },
    /** Чтение пошло: запускаем отсчёт, если он ещё не запущен. */
    arm(pageNumber) {
      if (mode === 'off' || armed) return;
      armed = true;
      if (mode === 'minutes') until = Date.now() + minutes * 60_000;
      if (mode === 'chapter') stopPage = chapterEndAfter(pageNumber);
      clearInterval(ticker);
      ticker = setInterval(render, 15_000);
      render();
    },
    shouldStop(pageNumber) {
      if (!armed) return false;
      if (mode === 'minutes') return Date.now() >= until;
      if (mode === 'chapter') return Boolean(stopPage) && pageNumber >= stopPage;
      return false;
    },
    /** Множитель громкости: последние секунды перед остановкой голос затихает. */
    volumeFactor() {
      if (mode !== 'minutes' || !until) return 1;
      const left = until - Date.now();
      return left >= FADE_MS ? 1 : Math.max(0.15, left / FADE_MS);
    },
    get active() {
      return mode !== 'off';
    },
  };
}
