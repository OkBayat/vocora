(() => {
  'use strict';

  const STORY_WIDTH = 1080;
  const STORY_HEIGHT = 1920;
  const STORY_SAFE_TOP = 270;
  const STORY_SAFE_BOTTOM = 1536;
  const STORY_MIME_TYPE = 'image/png';
  const BRAND_URL = 'vocora.ir';
  const faNumber = new Intl.NumberFormat('fa-IR');
  const faDate = new Intl.DateTimeFormat('fa-IR', { day: 'numeric', month: 'long', year: 'numeric' });

  const THEMES = {
    session: { start: '#071b35', end: '#0b67ad', accent: '#73d7ff', soft: 'rgba(115, 215, 255, .18)' },
    daily: { start: '#09213e', end: '#126fc0', accent: '#77dcff', soft: 'rgba(119, 220, 255, .18)' },
    streak: { start: '#271439', end: '#b94765', accent: '#ffd271', soft: 'rgba(255, 210, 113, .18)' },
    mastery: { start: '#073039', end: '#087f80', accent: '#77efd6', soft: 'rgba(119, 239, 214, .18)' },
    momentum: { start: '#211244', end: '#6142ad', accent: '#cdb6ff', soft: 'rgba(205, 182, 255, .18)' },
    journey: { start: '#101d37', end: '#185aa0', accent: '#8bd6ff', soft: 'rgba(139, 214, 255, .18)' }
  };

  function localDay(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function shiftDay(day, amount) {
    const [year, month, date] = day.split('-').map(Number);
    return localDay(new Date(year, month - 1, date + amount, 12));
  }

  function percent(value, total) {
    const numerator = Number(value);
    const denominator = Number(total);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)));
  }

  function safeCorrect(record) {
    const attempts = Math.max(0, Number(record?.attempts) || 0);
    const correct = Math.max(0, Number(record?.correct) || 0);
    return Math.min(attempts, correct);
  }

  function sumCorrectDays(daily, endDay, length) {
    let total = 0;
    for (let index = 0; index < length; index += 1) {
      total += safeCorrect(daily[shiftDay(endDay, -index)]);
    }
    return total;
  }

  function streakFor(daily, today) {
    let cursor = today;
    if (!(Number(daily[cursor]?.attempts) > 0)) cursor = shiftDay(cursor, -1);
    let streak = 0;
    while (Number(daily[cursor]?.attempts) > 0) {
      streak += 1;
      cursor = shiftDay(cursor, -1);
    }
    return streak;
  }

  function publicMoment(source) {
    return {
      id: source.id,
      kind: source.kind,
      tabLabel: source.tabLabel,
      eyebrow: source.eyebrow,
      title: source.title,
      value: source.value,
      unit: source.unit,
      message: source.message,
      stats: source.stats.slice(0, 3).map(({ value, label }) => ({ value: String(value), label: String(label) })),
      progress: Math.max(0, Math.min(1, Number(source.progress) || 0)),
      trend: Array.isArray(source.trend) ? source.trend.map((value) => Math.max(0, Number(value) || 0)).slice(-7) : [],
      date: source.date,
      caption: source.caption,
      score: source.score
    };
  }

  function buildShareMoments(state, options = {}) {
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const today = options.today || localDay(now);
    const daily = state?.daily && typeof state.daily === 'object' ? state.daily : {};
    const words = Array.isArray(state?.words) ? state.words : [];
    const settings = state?.settings || {};
    const todayRecord = daily[today] || {};
    const attempts = Math.max(0, Number(todayRecord.attempts) || 0);
    const correct = safeCorrect(todayRecord);
    const dailyGoal = Math.max(1, Number(settings.dailyGoal) || 20);
    const streak = streakFor(daily, today);
    const mastered = words.filter((word) => Number(word.box) === 5).length;
    const introduced = words.filter((word) => Number(word.box) > 0 || word.introducedOn).length;
    const activeDays = Object.values(daily).filter((record) => Number(record?.attempts) > 0).length;
    const weekValues = Array.from({ length: 7 }, (_, index) => safeCorrect(daily[shiftDay(today, index - 6)]));
    const currentWeek = weekValues.reduce((sum, value) => sum + value, 0);
    const previousWeek = sumCorrectDays(daily, shiftDay(today, -7), 7);
    const displayDate = faDate.format(now);
    const moments = [];
    const session = options.session;

    if (session && Number(session.answered) > 0) {
      const sessionAnswered = Number(session.answered) || 0;
      const sessionCorrect = Number(session.correct) || 0;
      const sessionAccuracy = percent(sessionCorrect, sessionAnswered);
      const durationMinutes = Math.max(1, Number(session.durationMinutes) || 1);
      const showAccuracy = sessionAnswered >= 5 && sessionAccuracy >= 70;
      moments.push(publicMoment({
        id: 'session',
        kind: 'session',
        tabLabel: 'جلسهٔ من',
        eyebrow: 'یک قدم واقعی رو به جلو',
        title: 'امروز برای هدفم وقت گذاشتم',
        value: faNumber.format(sessionAnswered),
        unit: 'پاسخ در یک جلسه',
        message: 'تمرین کوتاه، تمرکز واقعی و یک قدم نزدیک‌تر به Listening بهتر.',
        stats: [
          { value: `${faNumber.format(durationMinutes)} دقیقه`, label: 'تمرین متمرکز' },
          { value: `${faNumber.format(Math.min(attempts, dailyGoal))}/${faNumber.format(dailyGoal)}`, label: 'هدف روزانه' },
          ...(showAccuracy ? [{ value: `${faNumber.format(sessionAccuracy)}٪`, label: 'دقت جلسه' }] : [])
        ],
        progress: Math.min(1, sessionAnswered / dailyGoal),
        trend: weekValues,
        date: displayDate,
        caption: `امروز در Vocora یک جلسهٔ ${faNumber.format(sessionAnswered)} پاسخی را کامل کردم. قدم‌های کوچک، پیوسته و واقعی.`,
        score: 120
      }));
    }

    if (attempts > 0) {
      const todayAccuracy = percent(correct, attempts);
      const goalComplete = attempts >= dailyGoal;
      const durationMinutes = Math.ceil(Math.max(0, Number(todayRecord.durationSeconds) || 0) / 60);
      const showAccuracy = attempts >= 5 && todayAccuracy >= 70;
      moments.push(publicMoment({
        id: 'daily',
        kind: 'daily',
        tabLabel: 'امروز',
        eyebrow: goalComplete ? 'هدف امروز کامل شد' : 'پیشرفت امروز',
        title: goalComplete ? 'برنامهٔ امروز را کامل کردم' : 'امروز حافظه‌ام را تمرین دادم',
        value: faNumber.format(attempts),
        unit: 'پاسخ تمرینی امروز',
        message: goalComplete ? 'هر روز کمی تمرین؛ هر هفته یک قدم جلوتر.' : 'قرار نیست یک‌باره کامل باشم؛ مهم این است که ادامه می‌دهم.',
        stats: [
          { value: `${faNumber.format(Math.min(attempts, dailyGoal))}/${faNumber.format(dailyGoal)}`, label: 'هدف روزانه' },
          durationMinutes > 0
            ? { value: `${faNumber.format(durationMinutes)} دقیقه`, label: 'زمان متمرکز' }
            : { value: faNumber.format(activeDays), label: 'روز تمرین' },
          ...(showAccuracy ? [{ value: `${faNumber.format(todayAccuracy)}٪`, label: 'دقت امروز' }] : [])
        ],
        progress: Math.min(1, attempts / dailyGoal),
        trend: weekValues,
        date: displayDate,
        caption: goalComplete
          ? `هدف تمرین امروز من در Vocora کامل شد؛ ${faNumber.format(attempts)} پاسخ تمرینی و یک قدم دیگر رو به جلو.`
          : `امروز در Vocora ${faNumber.format(attempts)} پاسخ تمرینی ثبت کردم. کم، پیوسته و رو به جلو.`,
        score: goalComplete ? 110 : 80
      }));
    }

    if (streak >= 2) {
      moments.push(publicMoment({
        id: 'streak',
        kind: 'streak',
        tabLabel: 'پیوستگی',
        eyebrow: 'ریتم یادگیری من',
        title: `${faNumber.format(streak)} روز پیوسته تمرین کردم`,
        value: faNumber.format(streak),
        unit: 'روز ادامه‌دار',
        message: 'هر روز کم، اما ادامه‌دار؛ این ریتمی است که برای خودم ساخته‌ام.',
        stats: [
          { value: faNumber.format(activeDays), label: 'کل روزهای فعال' },
          { value: faNumber.format(currentWeek), label: 'درست‌های این هفته' }
        ],
        progress: Math.min(1, streak / 7),
        trend: weekValues,
        date: displayDate,
        caption: `${faNumber.format(streak)} روز است که برای یادگیری واژگانم وقت می‌گذارم. هر روز کم، اما ادامه‌دار.`,
        score: streak >= 7 ? 105 : 90
      }));
    }

    if (mastered > 0) {
      moments.push(publicMoment({
        id: 'mastery',
        kind: 'mastery',
        tabLabel: 'تسلط',
        eyebrow: 'پیشرفت ماندگار',
        title: 'این واژه‌ها چند مرحله با من مانده‌اند',
        value: faNumber.format(mastered),
        unit: 'واژه در خانهٔ تسلط',
        message: 'مرور فاصله‌دار یعنی ساختن حافظه‌ای که فردا هم همراه من می‌ماند.',
        stats: [
          { value: faNumber.format(introduced), label: 'وارد مسیر شده' },
          { value: faNumber.format(activeDays), label: 'روز تمرین' }
        ],
        progress: words.length ? mastered / words.length : 0,
        trend: weekValues,
        date: displayDate,
        caption: `به ${faNumber.format(mastered)} واژه در خانهٔ تسلط Vocora رسیدم؛ نتیجهٔ مرورهای کوتاه و فاصله‌دار.`,
        score: [10, 25, 50, 100, 250, 500, 1000].includes(mastered) ? 115 : 75
      }));
    }

    if (previousWeek >= 10 && currentWeek > previousWeek) {
      const growth = Math.round(((currentWeek - previousWeek) / previousWeek) * 100);
      moments.push(publicMoment({
        id: 'momentum',
        kind: 'momentum',
        tabLabel: 'رشد هفتگی',
        eyebrow: 'مقایسه با خودِ هفتهٔ قبل',
        title: 'این هفته ریتم بهتری ساختم',
        value: `+${faNumber.format(growth)}٪`,
        unit: 'پاسخ درست بیشتر',
        message: 'رقیب من فقط نسخهٔ هفتهٔ قبل خودم است.',
        stats: [
          { value: faNumber.format(currentWeek), label: '۷ روز اخیر' },
          { value: faNumber.format(previousWeek), label: '۷ روز قبل' }
        ],
        progress: Math.min(1, currentWeek / Math.max(currentWeek, previousWeek * 1.5)),
        trend: weekValues,
        date: displayDate,
        caption: `در ۷ روز اخیر در Vocora نسبت به ۷ روز قبل ${faNumber.format(growth)}٪ پاسخ درست بیشتری ثبت کردم.`,
        score: 85
      }));
    }

    if (!moments.length) {
      const isReturningLearner = activeDays > 0;
      moments.push(publicMoment({
        id: 'journey',
        kind: 'journey',
        tabLabel: isReturningLearner ? 'مسیر من' : 'شروع مسیر',
        eyebrow: isReturningLearner ? 'پیشرفت ماندگار، قدم‌به‌قدم' : 'تعهد کوچک امروز من',
        title: isReturningLearner ? 'مسیر تمرینم را ادامه می‌دهم' : 'مسیر واژگانم را شروع کردم',
        value: faNumber.format(isReturningLearner ? activeDays : introduced),
        unit: isReturningLearner ? 'روز تمرین ثبت‌شده' : 'واژه آمادهٔ تمرین',
        message: isReturningLearner
          ? 'هر بار بازگشتن به تمرین، بخشی از پیشرفت واقعی من است.'
          : 'از امروز، هر بار چند دقیقه برای Listening بهتر وقت می‌گذارم.',
        stats: isReturningLearner
          ? [
            { value: faNumber.format(introduced), label: 'واژه وارد مسیر' },
            { value: faNumber.format(dailyGoal), label: 'هدف پاسخ روزانه' }
          ]
          : [
            { value: faNumber.format(Number(settings.dailyNew) || 10), label: 'هدف واژهٔ روزانه' },
            { value: faNumber.format(dailyGoal), label: 'هدف پاسخ روزانه' }
          ],
        progress: 0,
        trend: weekValues,
        date: displayDate,
        caption: isReturningLearner
          ? `تا امروز در ${faNumber.format(activeDays)} روز جداگانه با Vocora تمرین کرده‌ام؛ هر بار بازگشتن یک قدم واقعی است.`
          : 'مسیر تمرین واژگانم را در Vocora شروع کردم؛ هر روز کمی، اما پیوسته.',
        score: 10
      }));
    }

    return moments.sort((a, b) => b.score - a.score).map((moment, index) => ({ ...moment, recommended: index === 0 }));
  }

  function pathRoundRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function fillRoundRect(ctx, x, y, width, height, radius, fill) {
    pathRoundRect(ctx, x, y, width, height, radius);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 2) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth || !line) line = candidate;
      else {
        lines.push(line);
        line = word;
        if (lines.length === maxLines - 1) break;
      }
    }
    if (line && lines.length < maxLines) lines.push(line);
    lines.forEach((value, index) => ctx.fillText(value, x, y + index * lineHeight, maxWidth));
    return lines.length;
  }

  function configureCanvas(canvas) {
    canvas.width = STORY_WIDTH;
    canvas.height = STORY_HEIGHT;
    return canvas;
  }

  async function renderStory(canvas, moment) {
    configureCanvas(canvas);
    if (globalThis.document?.fonts?.ready) {
      try {
        await Promise.all([
          globalThis.document.fonts.load('400 32px Vazirmatn', 'پیشرفت امروز'),
          globalThis.document.fonts.load('700 64px Vazirmatn', 'تمرین واژگان'),
          globalThis.document.fonts.ready
        ]);
      } catch { /* A system font is a safe fallback. */ }
    }
    const ctx = canvas.getContext?.('2d');
    if (!ctx) throw new Error('مرورگر نتوانست بوم تصویر را آماده کند.');
    const theme = THEMES[moment.kind] || THEMES.daily;
    const gradient = ctx.createLinearGradient(0, 0, STORY_WIDTH, STORY_HEIGHT);
    gradient.addColorStop(0, theme.start);
    gradient.addColorStop(1, theme.end);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, STORY_WIDTH, STORY_HEIGHT);

    ctx.save();
    ctx.globalAlpha = 0.13;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 56;
    [250, 410, 585].forEach((radius) => {
      ctx.beginPath();
      ctx.arc(955, 205, radius, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = '#ffffff';
    for (let index = 0; index < 38; index += 1) {
      const x = (index * 173 + 91) % STORY_WIDTH;
      const y = (index * 307 + 77) % STORY_HEIGHT;
      ctx.beginPath();
      ctx.arc(x, y, 3 + (index % 4), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    ctx.textBaseline = 'alphabetic';
    ctx.direction = 'ltr';
    fillRoundRect(ctx, 84, STORY_SAFE_TOP, 92, 92, 28, '#ffffff');
    ctx.fillStyle = theme.end;
    ctx.font = '800 48px "Vazirmatn", Tahoma, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('V', 130, 332);
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 46px "Segoe UI", Tahoma, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('VOCORA', 198, 315);
    ctx.fillStyle = 'rgba(255,255,255,.72)';
    ctx.font = '400 28px "Segoe UI", Tahoma, sans-serif';
    ctx.fillText(`${BRAND_URL}  ·  Small practice. Lasting progress.`, 198, 352);

    ctx.direction = 'rtl';
    ctx.textAlign = 'center';
    fillRoundRect(ctx, 330, 390, 420, 64, 32, theme.soft);
    ctx.fillStyle = theme.accent;
    ctx.font = '600 34px "Vazirmatn", Tahoma, "Segoe UI", sans-serif';
    ctx.fillText(moment.eyebrow, 540, 433, 370);

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 64px "Vazirmatn", Tahoma, "Segoe UI", sans-serif';
    drawWrappedText(ctx, moment.title, 540, 520, 850, 84, 2);

    ctx.shadowColor = 'rgba(0,0,0,.16)';
    ctx.shadowBlur = 30;
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${String(moment.value).length > 5 ? 150 : 208}px "Vazirmatn", Tahoma, "Segoe UI", sans-serif`;
    ctx.fillText(moment.value, 540, 825, 850);
    ctx.shadowBlur = 0;
    ctx.fillStyle = theme.accent;
    ctx.font = '600 40px "Vazirmatn", Tahoma, "Segoe UI", sans-serif';
    ctx.fillText(moment.unit, 540, 895, 780);

    const statCount = Math.max(1, moment.stats.length);
    const gap = 22;
    const cardsWidth = 912;
    const cardWidth = (cardsWidth - gap * (statCount - 1)) / statCount;
    moment.stats.forEach((stat, index) => {
      const x = 84 + index * (cardWidth + gap);
      fillRoundRect(ctx, x, 985, cardWidth, 176, 34, 'rgba(255,255,255,.105)');
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 42px "Vazirmatn", Tahoma, "Segoe UI", sans-serif';
      ctx.fillText(stat.value, x + cardWidth / 2, 1060, cardWidth - 28);
      ctx.fillStyle = 'rgba(255,255,255,.7)';
      ctx.font = '400 32px "Vazirmatn", Tahoma, "Segoe UI", sans-serif';
      ctx.fillText(stat.label, x + cardWidth / 2, 1119, cardWidth - 28);
    });

    if (moment.trend.some(Boolean)) {
      const chartX = 108;
      const chartY = 1228;
      const chartWidth = 864;
      const chartHeight = 112;
      const max = Math.max(...moment.trend, 1);
      const step = chartWidth / Math.max(1, moment.trend.length - 1);
      ctx.beginPath();
      moment.trend.forEach((value, index) => {
        const x = chartX + index * step;
        const y = chartY + chartHeight - (value / max) * chartHeight;
        if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 8;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.62)';
      ctx.font = '400 30px "Vazirmatn", Tahoma, "Segoe UI", sans-serif';
      ctx.fillText('ریتم پاسخ‌های درست در هفت روز اخیر', 540, 1387);
    } else {
      fillRoundRect(ctx, 108, 1262, 864, 24, 12, 'rgba(255,255,255,.14)');
      if (moment.progress > 0) {
        fillRoundRect(ctx, 108, 1262, Math.max(24, 864 * moment.progress), 24, 12, theme.accent);
      }
      ctx.fillStyle = 'rgba(255,255,255,.72)';
      ctx.font = '400 30px "Vazirmatn", Tahoma, "Segoe UI", sans-serif';
      ctx.fillText(moment.progress > 0 ? 'پیشرفت من در این مسیر' : 'آمادهٔ اولین قدم', 540, 1360);
    }

    ctx.fillStyle = '#ffffff';
    ctx.font = '600 38px "Vazirmatn", Tahoma, "Segoe UI", sans-serif';
    drawWrappedText(ctx, moment.message, 540, 1455, 840, 56, 2);

    ctx.fillStyle = theme.accent;
    ctx.fillRect(84, 1575, 912, 4);
    return canvas;
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      if (typeof canvas.toBlob !== 'function') {
        reject(new Error('ساخت تصویر در این مرورگر پشتیبانی نمی‌شود.'));
        return;
      }
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('ساخت فایل تصویر کامل نشد.'));
      }, STORY_MIME_TYPE, 1);
    });
  }

  async function storyFile(canvas, moment) {
    const blob = await canvasToBlob(canvas);
    const filename = `vocora-${moment.id}-${localDay()}.png`;
    return new File([blob], filename, { type: STORY_MIME_TYPE, lastModified: Date.now() });
  }

  function shareText(moment) {
    return `${moment.caption}\n\n${BRAND_URL}\n#Vocora #یادگیری_زبان`;
  }

  function buildSharePayload(file, moment) {
    return {
      files: [file],
      title: 'داستان پیشرفت من در Vocora',
      text: moment ? shareText(moment) : `پیشرفت من در Vocora\n\n${BRAND_URL}`
    };
  }

  function supportsFileShare(navigatorObject = globalThis.navigator, moment = null) {
    if (!navigatorObject?.share || !navigatorObject?.canShare || typeof File !== 'function') return false;
    try {
      const probe = new File(['vocora'], 'vocora.png', { type: STORY_MIME_TYPE });
      return navigatorObject.canShare(buildSharePayload(probe, moment));
    } catch {
      return false;
    }
  }

  async function shareStory(canvas, moment, navigatorObject = globalThis.navigator, preparedFile = null) {
    const file = preparedFile || await storyFile(canvas, moment);
    const payload = buildSharePayload(file, moment);
    if (!navigatorObject?.share || !navigatorObject?.canShare || !navigatorObject.canShare(payload)) {
      return { status: 'unsupported', file };
    }
    try {
      await navigatorObject.share(payload);
      return { status: 'shared', file };
    } catch (error) {
      if (error?.name === 'AbortError') return { status: 'cancelled', file };
      throw error;
    }
  }

  async function downloadStory(canvas, moment, documentObject = globalThis.document, preparedFile = null) {
    const file = preparedFile || await storyFile(canvas, moment);
    const url = URL.createObjectURL(file);
    const link = documentObject.createElement('a');
    link.href = url;
    link.download = file.name;
    link.style.display = 'none';
    documentObject.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return file;
  }

  async function copyCaption(moment, navigatorObject = globalThis.navigator, documentObject = globalThis.document) {
    const text = shareText(moment);
    if (navigatorObject?.clipboard?.writeText) {
      await navigatorObject.clipboard.writeText(text);
      return text;
    }
    const input = documentObject.createElement('textarea');
    input.value = text;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    documentObject.body.appendChild(input);
    input.select();
    const copied = documentObject.execCommand?.('copy');
    input.remove();
    if (!copied) throw new Error('کپی متن در این مرورگر پشتیبانی نمی‌شود.');
    return text;
  }

  globalThis.VocoraShare = {
    STORY_WIDTH,
    STORY_HEIGHT,
    STORY_SAFE_TOP,
    STORY_SAFE_BOTTOM,
    STORY_MIME_TYPE,
    buildShareMoments,
    configureCanvas,
    renderStory,
    storyFile,
    shareText,
    buildSharePayload,
    supportsFileShare,
    shareStory,
    downloadStory,
    copyCaption
  };
})();
