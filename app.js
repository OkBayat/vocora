(() => {
  'use strict';

  const STORAGE_KEY = 'vazheyar-ielts-state-v1';
  const SCHEMA_VERSION = 2;
  const BOX_WAIT_DAYS = [0, 1, 2, 3, 7, 14];
  const PAGE_SIZE = 40;
  const faNumber = new Intl.NumberFormat('fa-IR');
  const faDate = new Intl.DateTimeFormat('fa-IR', { weekday: 'long', day: 'numeric', month: 'long' });
  const shortFaDate = new Intl.DateTimeFormat('fa-IR', { month: 'short', day: 'numeric' });

  let state = loadState();
  let currentView = 'dashboard';
  let wordsPage = 1;
  let reviewQueue = [];
  let currentWord = null;
  let session = null;
  let feedbackOpen = false;
  let toastTimer = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function localDay(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function addDays(day, amount) {
    const [year, month, date] = day.split('-').map(Number);
    const result = new Date(year, month - 1, date + amount, 12);
    return localDay(result);
  }

  function daysAgo(amount) {
    const date = new Date();
    date.setDate(date.getDate() - amount);
    return localDay(date);
  }

  function createWord(source, index = 0) {
    const accepted = Array.isArray(source.accepted) ? source.accepted : String(source.term || '').split(/\s+\/\s+/);
    const cleanAccepted = [...new Set(accepted.map((item) => item.trim()).filter(Boolean))];
    return {
      id: source.id || uid(),
      number: Number(source.number) || index + 1,
      term: cleanAccepted[0] || String(source.term || '').trim(),
      accepted: cleanAccepted,
      category: source.category || 'بدون دسته‌بندی',
      notes: source.notes || '',
      createdAt: source.createdAt || new Date().toISOString(),
      box: clamp(Number(source.box) || 0, 0, 5),
      due: source.due || null,
      attempts: Number(source.attempts) || 0,
      correct: Number(source.correct) || 0,
      mistakes: Number(source.mistakes) || 0,
      currentStreak: Number(source.currentStreak) || 0,
      introducedOn: source.introducedOn || null,
      addedSource: source.addedSource || null,
      lastReviewed: source.lastReviewed || null,
      lastPromotedDay: source.lastPromotedDay || null,
      blockedUntil: source.blockedUntil || null,
      masteredAt: source.masteredAt || null
    };
  }

  function defaultState() {
    const defaults = Array.isArray(window.IELTS_CORE_WORDS) ? window.IELTS_CORE_WORDS : [];
    return {
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settings: { dailyNew: 10, dailyGoal: 20, voiceRate: 0.85, theme: 'system' },
      words: defaults.map(createWord),
      daily: {},
      history: []
    };
  }

  function loadState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return defaultState();
      const parsed = JSON.parse(saved);
      if (!parsed || !Array.isArray(parsed.words)) throw new Error('Invalid state');
      const sourceVersion = Number(parsed.schemaVersion) || 1;
      const clean = {
        ...defaultState(),
        ...parsed,
        schemaVersion: SCHEMA_VERSION,
        settings: { ...defaultState().settings, ...(parsed.settings || {}) },
        words: parsed.words.map(createWord),
        daily: parsed.daily || {},
        history: Array.isArray(parsed.history) ? parsed.history : []
      };
      if (sourceVersion < 2) migrateLegacyProgress(clean);
      return clean;
    } catch (error) {
      console.error('Could not load saved data:', error);
      return defaultState();
    }
  }

  function saveState() {
    state.updatedAt = new Date().toISOString();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      showToast('فضای ذخیره‌سازی مرورگر کافی نیست؛ یک پشتیبان بگیر.', true);
      console.error(error);
    }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function normalizeAnswer(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase('en')
      .replace(/[’‘]/g, "'")
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isCorrectAnswer(value, word) {
    const answer = normalizeAnswer(value);
    return Boolean(answer) && word.accepted.some((item) => normalizeAnswer(item) === answer);
  }

  function todayRecord() {
    const today = localDay();
    const defaults = { attempts: 0, correct: 0, wrong: 0, newAdded: 0, sessions: 0, durationSeconds: 0 };
    const existing = state.daily[today] || {};
    state.daily[today] = { ...defaults, ...existing };
    if (!Object.prototype.hasOwnProperty.call(existing, 'newAdded')) {
      state.daily[today].newAdded = state.words.filter((word) => word.introducedOn === today).length;
    }
    return state.daily[today];
  }

  function migrateLegacyProgress(targetState) {
    const eventsByWord = new Map();
    targetState.history.forEach((event) => {
      if (!event.wordId) return;
      if (!eventsByWord.has(event.wordId)) eventsByWord.set(event.wordId, []);
      eventsByWord.get(event.wordId).push(event);
    });
    targetState.words.forEach((word) => {
      const events = (eventsByWord.get(word.id) || []).sort((a, b) => String(a.at || a.day).localeCompare(String(b.at || b.day)));
      if (!events.length) return;
      const firstDay = events[0].day || localDay(new Date(events[0].at));
      word.box = 1;
      word.introducedOn = firstDay;
      word.due = firstDay;
      word.lastPromotedDay = null;
      word.blockedUntil = null;
      word.masteredAt = null;
      events.forEach((event) => {
        const day = event.day || localDay(new Date(event.at));
        if (!event.correct) {
          word.box = 1;
          word.due = addDays(day, 1);
          word.blockedUntil = addDays(day, 1);
          word.masteredAt = null;
          return;
        }
        const eligible = word.due <= day && (!word.blockedUntil || word.blockedUntil <= day) && word.lastPromotedDay !== day;
        if (!eligible) return;
        word.box = Math.min(5, word.box + 1);
        word.lastPromotedDay = day;
        word.blockedUntil = null;
        word.due = addDays(day, BOX_WAIT_DAYS[word.box]);
        if (word.box === 5) word.masteredAt = event.at || new Date(`${day}T12:00:00`).toISOString();
      });
    });
  }

  function ensureDailyWords() {
    const today = localDay();
    const daily = todayRecord();
    const alreadyAdded = state.words.filter((word) => word.introducedOn === today).length;
    daily.newAdded = Math.max(Number(daily.newAdded) || 0, alreadyAdded);
    const remaining = Math.max(0, state.settings.dailyNew - daily.newAdded);
    if (!remaining) return 0;
    const newcomers = state.words
      .filter((word) => word.box === 0 && !word.introducedOn)
      .sort((a, b) => a.number - b.number)
      .slice(0, remaining);
    const activated = activateUnseenWords(newcomers, 'daily');
    if (activated.length) saveState();
    return activated.length;
  }

  function activateUnseenWords(words, source = 'manual') {
    const today = localDay();
    const activated = words.filter((word) => word && word.box === 0 && !word.introducedOn);
    activated.forEach((word) => {
      word.box = 1;
      word.introducedOn = today;
      word.due = today;
      word.blockedUntil = null;
      word.lastPromotedDay = null;
      word.addedSource = source;
    });
    todayRecord().newAdded += activated.length;
    return activated;
  }

  function addWordToBoxOne(id) {
    const word = state.words.find((item) => item.id === id);
    const [activated] = activateUnseenWords([word], 'word-bank');
    if (!activated) return showToast('این واژه قبلاً وارد یکی از خانه‌ها شده است.');
    saveState();
    renderWords();
    renderGlobal();
    showToast(`«${word.term}» به خانهٔ ۱ اضافه شد و آمادهٔ آزمون است.`);
  }

  function openNewWordsDialog() {
    const available = state.words.filter((word) => word.box === 0 && !word.introducedOn).length;
    if (!available) return showToast('همهٔ واژه‌ها قبلاً وارد جعبه شده‌اند.');
    const maximum = Math.min(50, available);
    $('#availableWordsCount').textContent = faNumber.format(available);
    $('#newWordsCountInput').max = String(maximum);
    $('#newWordsCountInput').value = String(Math.min(10, maximum));
    $('#newWordsDialog').showModal();
    setTimeout(() => $('#newWordsCountInput').focus(), 50);
  }

  function startSelectedNewWords(event) {
    event.preventDefault();
    const available = state.words.filter((word) => word.box === 0 && !word.introducedOn).sort((a, b) => a.number - b.number);
    const maximum = Math.min(50, available.length);
    const requested = clamp(Number($('#newWordsCountInput').value) || 1, 1, maximum);
    const activated = activateUnseenWords(available.slice(0, requested), 'home-selection');
    if (!activated.length) return showToast('لغت جدیدی برای افزودن باقی نمانده است.');
    saveState();
    $('#newWordsDialog').close();
    showView('review');
    startSession('new', activated.map((word) => word.id));
  }

  function getDueWords() {
    const today = localDay();
    return state.words
      .filter((word) => word.box > 0 && word.due && word.due <= today && (!word.blockedUntil || word.blockedUntil <= today))
      .sort((a, b) => (a.due || '').localeCompare(b.due || '') || b.mistakes - a.mistakes || a.number - b.number);
  }

  function getNewWordsDueToday() {
    const today = localDay();
    return getDueWords().filter((word) => word.introducedOn === today && word.box === 1);
  }

  function totalStats() {
    return state.words.reduce((sum, word) => {
      sum.attempts += word.attempts;
      sum.correct += word.correct;
      sum.mistakes += word.mistakes;
      if (word.box === 5) sum.mastered += 1;
      if (word.box > 0) sum.learning += 1;
      return sum;
    }, { attempts: 0, correct: 0, mistakes: 0, mastered: 0, learning: 0 });
  }

  function accuracy(correct, attempts) {
    return attempts ? Math.round((correct / attempts) * 100) : null;
  }

  function calculateStreak() {
    let streak = 0;
    const cursor = new Date();
    if (!(state.daily[localDay(cursor)]?.attempts > 0)) cursor.setDate(cursor.getDate() - 1);
    while (state.daily[localDay(cursor)]?.attempts > 0) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  function applyTheme() {
    const theme = state.settings.theme || 'system';
    const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }

  function cycleTheme() {
    const current = state.settings.theme || 'system';
    state.settings.theme = current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system';
    saveState();
    applyTheme();
    const names = { system: 'هماهنگ با دستگاه', light: 'روشن', dark: 'تیره' };
    showToast(`پوسته: ${names[state.settings.theme]}`);
  }

  function showView(name) {
    currentView = name;
    $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
    $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === name));
    const titles = { dashboard: 'سلام محمد 👋', review: 'مرور امروز', words: 'بانک واژه‌ها', reports: 'گزارش رشد', settings: 'تنظیمات' };
    $('#pageTitle').textContent = titles[name];
    if (name === 'dashboard') renderDashboard();
    if (name === 'review') renderReviewSetup();
    if (name === 'words') renderWords();
    if (name === 'reports') renderReports();
    if (name === 'settings') renderSettings();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    history.replaceState(null, '', `#${name}`);
  }

  function renderGlobal() {
    ensureDailyWords();
    const due = getDueWords().length;
    const stats = totalStats();
    const masteredPercent = state.words.length ? Math.round((stats.mastered / state.words.length) * 100) : 0;
    $('#todayLabel').textContent = faDate.format(new Date());
    $('#streakCount').textContent = faNumber.format(calculateStreak());
    $('#navDueBadge').textContent = faNumber.format(due);
    $('#sideProgressText').textContent = `${faNumber.format(masteredPercent)}٪`;
    $('#sideProgressBar').style.width = `${masteredPercent}%`;
    $('#sideProgressCaption').textContent = `${faNumber.format(stats.mastered)} از ${faNumber.format(state.words.length)} کلمه در خانهٔ ۵`;
  }

  function renderDashboard() {
    renderGlobal();
    const today = todayRecord();
    const due = getDueWords().length;
    const stats = totalStats();
    const dailyProgress = clamp(Math.round((today.attempts / state.settings.dailyGoal) * 100), 0, 100);
    const newRemaining = Math.max(0, state.settings.dailyNew - today.newAdded);
    $('#dailyRing').style.setProperty('--progress', `${dailyProgress * 3.6}deg`);
    $('#dailyRingValue').textContent = faNumber.format(today.attempts);
    $('#dailyRingGoal').textContent = `از ${faNumber.format(state.settings.dailyGoal)}`;
    $('#dueStat').textContent = faNumber.format(due);
    const totalAccuracy = accuracy(stats.correct, stats.attempts);
    $('#accuracyStat').textContent = totalAccuracy === null ? '—' : faNumber.format(totalAccuracy);
    $('#masteredStat').textContent = faNumber.format(stats.mastered);
    $('#newStat').textContent = faNumber.format(today.newAdded);
    $('#newStatGoal').textContent = `از ${faNumber.format(state.settings.dailyNew)}`;

    if (due === 0 && newRemaining === 0) {
      $('#heroTitle').textContent = 'برنامه‌ی امروز کامل شد!';
      $('#heroDescription').textContent = 'عالی بود. اگر دوست داری، تمرین آزاد خانهٔ ۱ را ادامه بده.';
      $('#startReviewBtn').textContent = 'مرور امروز کامل شد';
      $('#startReviewBtn').disabled = true;
    } else {
      $('#heroTitle').textContent = due ? `${faNumber.format(due)} مرور در انتظار توست` : 'برنامهٔ امروز کامل شد!';
      $('#heroDescription').textContent = 'مرورهای موعددار و لغات جدیدت را در یک جلسه‌ی کوتاه انجام بده.';
      $('#startReviewBtn').textContent = 'شروع مرور امروز';
      $('#startReviewBtn').disabled = false;
    }
    renderActivityChart();
    renderBoxDistribution();
    renderHardWordsPreview();
  }

  function renderActivityChart() {
    const days = Array.from({ length: 14 }, (_, index) => daysAgo(13 - index));
    const values = days.map((day) => state.daily[day]?.correct || 0);
    const max = Math.max(...values, 1);
    $('#activityChart').innerHTML = days.map((day, index) => {
      const value = values[index];
      const height = value ? Math.max(8, Math.round((value / max) * 120)) : 3;
      const date = new Date(`${day}T12:00:00`);
      return `<div class="bar-column" title="${escapeHtml(day)}: ${value} پاسخ درست"><span class="bar-value">${faNumber.format(value)}</span><i class="bar ${value ? 'has-data' : ''}" style="height:${height}px"></i><span class="bar-label">${index % 2 === 0 ? shortFaDate.format(date) : '·'}</span></div>`;
    }).join('');
    const firstHalf = values.slice(0, 7).reduce((a, b) => a + b, 0);
    const secondHalf = values.slice(7).reduce((a, b) => a + b, 0);
    const diff = secondHalf - firstHalf;
    $('#trendSummary').textContent = !values.some(Boolean) ? 'بدون داده' : diff >= 0 ? `${faNumber.format(diff)}+ نسبت به هفته قبل` : `${faNumber.format(Math.abs(diff))}- نسبت به هفته قبل`;
  }

  function renderBoxDistribution() {
    const learningWords = state.words.filter((word) => word.box > 0);
    const counts = [1, 2, 3, 4, 5].map((box) => learningWords.filter((word) => word.box === box).length);
    const max = Math.max(...counts, 1);
    $('#boxDistribution').innerHTML = counts.map((count, index) => `<div class="box-row"><span>خانهٔ ${faNumber.format(index + 1)}</span><div class="progress-track"><i style="width:${Math.round((count / max) * 100)}%"></i></div><span class="box-count">${faNumber.format(count)}</span></div>`).join('');
  }

  function hardWords(limit = 20) {
    return state.words.filter((word) => word.mistakes > 0).sort((a, b) => b.mistakes - a.mistakes || a.correct - b.correct || a.number - b.number).slice(0, limit);
  }

  function renderHardWordsPreview() {
    const words = hardWords(3);
    $('#hardWordsPreview').innerHTML = words.length ? words.map((word) => `<div class="word-preview"><span class="word-rank">${faNumber.format(word.mistakes)}×</span><div><strong>${escapeHtml(word.term)}</strong><small>${escapeHtml(word.category)} · ${faNumber.format(word.attempts)} تلاش</small></div></div>`).join('') : '<p class="no-data">هنوز خطایی ثبت نشده؛ بعد از اولین جلسه این بخش کامل می‌شود.</p>';
  }

  function renderReviewSetup() {
    renderGlobal();
    if (session && reviewQueue.length && !session.completed) {
      $('#reviewSetup').classList.add('hidden');
      $('#reviewEmpty').classList.add('hidden');
      $('#sessionComplete').classList.add('hidden');
      $('#reviewSession').classList.remove('hidden');
      return;
    }
    $('#reviewSession').classList.add('hidden');
    $('#sessionComplete').classList.add('hidden');
    const due = getDueWords();
    const newWords = getNewWordsDueToday();
    const scheduledWords = due.filter((word) => !newWords.includes(word));
    const total = due.length;
    if (!total) {
      $('#reviewSetup').classList.add('hidden');
      $('#reviewEmpty').classList.remove('hidden');
      return;
    }
    $('#reviewEmpty').classList.add('hidden');
    $('#reviewSetup').classList.remove('hidden');
    $('#setupDue').textContent = faNumber.format(scheduledWords.length);
    $('#setupNew').textContent = faNumber.format(newWords.length);
    $('#setupMinutes').textContent = faNumber.format(Math.max(1, Math.ceil(total * 0.35)));
    $('#reviewSetupSummary').textContent = `${faNumber.format(total)} کارت برای امروز آماده است.`;
  }

  function buildReviewQueue() {
    let queue = getDueWords();
    const limit = Number($('#sessionLimit').value || 0);
    if (limit) queue = queue.slice(0, limit);
    return queue.map((word) => word.id);
  }

  function weightedBoxOneBatch(size = 24, excludeId = null) {
    const words = state.words.filter((word) => word.box === 1);
    if (!words.length) return [];
    const result = [];
    let previousId = excludeId;
    for (let index = 0; index < size; index += 1) {
      const totalWeight = words.reduce((sum, word) => sum + 1 + Math.min(word.mistakes, 8) * 2, 0);
      let cursor = Math.random() * totalWeight;
      let selected = words[0];
      for (const word of words) {
        cursor -= 1 + Math.min(word.mistakes, 8) * 2;
        if (cursor <= 0) { selected = word; break; }
      }
      if (words.length > 1 && selected.id === previousId) {
        selected = words.find((word) => word.id !== previousId) || selected;
      }
      result.push(selected.id);
      previousId = selected.id;
    }
    return result;
  }

  function startSession(mode = 'scheduled', selectedWordIds = []) {
    if (session && !session.completed) recordSessionTime();
    reviewQueue = mode === 'box1' ? weightedBoxOneBatch() : mode === 'new' ? [...selectedWordIds] : buildReviewQueue();
    if (!reviewQueue.length) {
      const message = mode === 'box1' ? 'هنوز کارتی در خانهٔ ۱ وجود ندارد.' : mode === 'new' ? 'لغت جدیدی برای آزمون انتخاب نشده است.' : 'مرور موعدداری برای امروز وجود ندارد.';
      return showToast(message);
    }
    session = { mode, startedAt: Date.now(), initialCount: reviewQueue.length, answered: 0, correct: 0, wrong: 0, completed: false, retryCounts: {}, recorded: false };
    currentWord = null;
    $('#reviewSetup').classList.add('hidden');
    $('#reviewEmpty').classList.add('hidden');
    $('#sessionComplete').classList.add('hidden');
    $('#reviewSession').classList.remove('hidden');
    showNextCard();
  }

  function showNextCard() {
    feedbackOpen = false;
    if (!reviewQueue.length && session?.mode === 'box1') reviewQueue = weightedBoxOneBatch(24, currentWord?.id);
    if (!reviewQueue.length) return finishSession();
    const id = reviewQueue.shift();
    currentWord = state.words.find((word) => word.id === id);
    if (!currentWord) return showNextCard();
    if (session.mode === 'box1' && currentWord.box !== 1) return showNextCard();
    $('#answerForm').classList.remove('hidden');
    $('#dontKnowBtn').classList.remove('hidden');
    $('#answerFeedback').classList.add('hidden');
    $('#answerFeedback').classList.remove('wrong');
    $('#answerInput').value = '';
    $('#answerInput').disabled = false;
    $('#cardCategory').textContent = currentWord.category;
    $('#cardBox').textContent = currentWord.box ? `خانهٔ ${faNumber.format(currentWord.box)}` : 'هنوز وارد نشده';
    $('#cardInstruction').textContent = session.mode === 'box1'
      ? 'تمرین آزاد خانهٔ ۱؛ این پاسخ جای کارت را تغییر نمی‌دهد.'
      : session.mode === 'new' ? 'آزمون اولیه؛ پاسخ درست کارت را مستقیم به خانهٔ ۲ می‌برد.' : 'کلمه را بشنو و املای آن را بنویس.';
    updateSessionBar();
    setTimeout(() => speakWord(1), 250);
    setTimeout(() => $('#answerInput').focus(), 350);
  }

  function updateSessionBar() {
    if (session.mode === 'box1') {
      $('#sessionCounter').textContent = `تمرین آزاد · ${faNumber.format(session.answered)} پاسخ`;
      const freeAccuracy = accuracy(session.correct, session.answered);
      $('#sessionAccuracy').textContent = `دقت: ${freeAccuracy === null ? '—' : `${faNumber.format(freeAccuracy)}٪`}`;
      $('#sessionProgressBar').style.width = '100%';
      return;
    }
    const completedUnique = Math.min(session.answered, session.initialCount);
    const current = Math.min(session.initialCount, completedUnique + 1);
    $('#sessionCounter').textContent = `کارت ${faNumber.format(current)} از ${faNumber.format(session.initialCount)}`;
    const sessionAcc = accuracy(session.correct, session.answered);
    $('#sessionAccuracy').textContent = `دقت: ${sessionAcc === null ? '—' : `${faNumber.format(sessionAcc)}٪`}`;
    $('#sessionProgressBar').style.width = `${Math.round((completedUnique / session.initialCount) * 100)}%`;
  }

  function speakWord(multiplier = 1) {
    if (!currentWord || !('speechSynthesis' in window)) {
      showToast('مرورگر شما پخش تلفظ را پشتیبانی نمی‌کند.');
      return;
    }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(currentWord.term);
    utterance.lang = 'en-GB';
    utterance.rate = clamp(state.settings.voiceRate * multiplier, 0.45, 1.2);
    const voices = speechSynthesis.getVoices();
    utterance.voice = voices.find((voice) => /^en-GB/i.test(voice.lang)) || voices.find((voice) => /^en/i.test(voice.lang)) || null;
    speechSynthesis.speak(utterance);
  }

  function submitAnswer(answer, forcedWrong = false) {
    if (!currentWord || feedbackOpen) return;
    const correct = !forcedWrong && isCorrectAnswer(answer, currentWord);
    const today = localDay();
    const isFreePractice = session.mode === 'box1';
    feedbackOpen = true;
    session.answered += 1;
    if (correct) session.correct += 1;
    else session.wrong += 1;

    const previousBox = currentWord.box;
    const canGraduateNewBoxOne = previousBox === 1 && currentWord.mistakes === 0 && !currentWord.lastPromotedDay;
    let promoted = false;
    currentWord.attempts += 1;
    currentWord.lastReviewed = new Date().toISOString();
    if (correct) {
      currentWord.correct += 1;
      currentWord.currentStreak += 1;
      const eligible = (!isFreePractice || canGraduateNewBoxOne)
        && currentWord.due
        && currentWord.due <= today
        && (!currentWord.blockedUntil || currentWord.blockedUntil <= today)
        && currentWord.lastPromotedDay !== today;
      if (eligible) {
        currentWord.box = Math.min(5, Math.max(1, currentWord.box + 1));
        currentWord.lastPromotedDay = today;
        currentWord.blockedUntil = null;
        currentWord.due = addDays(today, BOX_WAIT_DAYS[currentWord.box]);
        promoted = true;
        if (currentWord.box === 5 && !currentWord.masteredAt) currentWord.masteredAt = new Date().toISOString();
      }
    } else {
      currentWord.mistakes += 1;
      currentWord.currentStreak = 0;
      currentWord.box = 1;
      currentWord.due = addDays(today, 1);
      currentWord.blockedUntil = addDays(today, 1);
      currentWord.masteredAt = null;
      if (session.mode === 'scheduled') {
        const repeats = session.retryCounts[currentWord.id] || 0;
        if (repeats < 1) {
          session.retryCounts[currentWord.id] = repeats + 1;
          reviewQueue.splice(Math.min(3, reviewQueue.length), 0, currentWord.id);
        }
      }
    }

    const daily = todayRecord();
    daily.attempts += 1;
    if (correct) daily.correct += 1;
    else daily.wrong += 1;
    state.history.push({
      at: new Date().toISOString(), day: today, wordId: currentWord.id, term: currentWord.term,
      answer: String(answer || ''), correct, mode: session.mode, promoted, previousBox, newBox: currentWord.box,
      mistakeNumber: correct ? null : currentWord.mistakes
    });
    if (state.history.length > 20000) state.history = state.history.slice(-20000);
    saveState();

    $('#answerForm').classList.add('hidden');
    $('#dontKnowBtn').classList.add('hidden');
    $('#answerFeedback').classList.remove('hidden');
    $('#answerFeedback').classList.toggle('wrong', !correct);
    $('#feedbackIcon').textContent = correct ? '✓' : '×';
    $('#feedbackTitle').textContent = correct ? 'درست بود!' : `این ${faNumber.format(currentWord.mistakes)}‌مین خطای تو برای این کلمه است`;
    if (!correct) {
      $('#feedbackDetail').textContent = `کلمه در خانهٔ ۱ می‌ماند و تا فردا امکان ارتقا ندارد.`;
    } else if (promoted) {
      $('#feedbackDetail').textContent = previousBox === currentWord.box
        ? `مرور خانهٔ ۵ ثبت شد؛ موعد بعدی ${faNumber.format(BOX_WAIT_DAYS[5])} روز دیگر است.`
        : `از خانهٔ ${faNumber.format(previousBox)} به خانهٔ ${faNumber.format(currentWord.box)} رفت.`;
    } else if (isFreePractice) {
      $('#feedbackDetail').textContent = 'تمرین ثبت شد؛ تمرین آزاد جای کارت‌های قبلی را تغییر نمی‌دهد.';
    } else {
      $('#feedbackDetail').textContent = currentWord.blockedUntil && currentWord.blockedUntil > today
        ? 'پاسخ درست ثبت شد، اما به‌دلیل خطای امروز انتقال تا فردا قفل است.'
        : 'پاسخ درست ثبت شد، اما هنوز روز موعد انتقال این کارت نرسیده است.';
    }
    $('#correctAnswer').textContent = currentWord.accepted.join(' / ');
    $('#wordNote').textContent = currentWord.notes || '';
    $('#wordNote').classList.toggle('hidden', !currentWord.notes);
    updateSessionBar();
    $('#nextCardBtn').focus();
  }

  function finishSession() {
    session.completed = true;
    const elapsed = recordSessionTime();
    $('#reviewSession').classList.add('hidden');
    $('#sessionComplete').classList.remove('hidden');
    const acc = accuracy(session.correct, session.answered) || 0;
    $('#completeCorrect').textContent = faNumber.format(session.correct);
    $('#completeWrong').textContent = faNumber.format(session.wrong);
    $('#completeAccuracy').textContent = `${faNumber.format(acc)}٪`;
    $('#completeSummary').textContent = `در ${faNumber.format(Math.max(1, Math.ceil(elapsed / 60)))} دقیقه، ${faNumber.format(session.answered)} پاسخ ثبت کردی.`;
    renderGlobal();
  }

  function recordSessionTime() {
    if (!session || session.recorded) return 0;
    const elapsed = Math.round((Date.now() - session.startedAt) / 1000);
    const daily = todayRecord();
    daily.sessions += 1;
    daily.durationSeconds += elapsed;
    session.recorded = true;
    saveState();
    return elapsed;
  }

  function exitSession() {
    if (!session || session.answered === 0 || confirm('جلسه را متوقف می‌کنی؟ پاسخ‌های ثبت‌شده حفظ می‌شوند.')) {
      recordSessionTime();
      window.speechSynthesis?.cancel?.();
      reviewQueue = [];
      currentWord = null;
      session = null;
      showView('dashboard');
    }
  }

  function parseWordFile(text) {
    const lines = String(text).split(/\r?\n/);
    let category = 'بدون دسته‌بندی';
    const results = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
      if (heading) {
        category = heading[1].replace(/\*+/g, '').trim();
        continue;
      }
      const numbered = line.match(/^\s*(\d+)[.)-]\s+(.+?)\s*$/);
      const bullet = line.match(/^[-*+]\s+(.+?)\s*$/);
      const plain = !numbered && !bullet && line && !/^\*|^>|^#/.test(line) ? line : null;
      const value = numbered?.[2] || bullet?.[1] || plain;
      if (!value || value.length > 160) continue;
      const cleaned = value.replace(/\*+/g, '').trim();
      if (!cleaned || /^(british spelling|\d+ study items)/i.test(cleaned)) continue;
      const accepted = cleaned.split(/\s+\/\s+/).map((part) => part.trim()).filter(Boolean);
      if (accepted.length) results.push({ number: Number(numbered?.[1]) || results.length + 1, term: accepted[0], accepted, category });
    }
    return results;
  }

  function importWords(text) {
    const parsed = parseWordFile(text);
    if (!parsed.length) throw new Error('هیچ کلمه‌ی معتبری در فایل پیدا نشد.');
    const existing = new Set(state.words.map((word) => normalizeAnswer(word.term)));
    let added = 0;
    parsed.forEach((item) => {
      if (!existing.has(normalizeAnswer(item.term))) {
        state.words.push(createWord(item, state.words.length));
        existing.add(normalizeAnswer(item.term));
        added += 1;
      }
    });
    saveState();
    renderWords();
    renderGlobal();
    return { found: parsed.length, added, skipped: parsed.length - added };
  }

  function renderWords() {
    renderGlobal();
    const search = normalizeAnswer($('#wordSearch').value);
    const box = $('#boxFilter').value;
    const sort = $('#sortWords').value;
    let words = state.words.filter((word) => {
      const matchesSearch = !search || normalizeAnswer(`${word.term} ${word.accepted.join(' ')} ${word.category}`).includes(search);
      const matchesBox = box === 'all' || word.box === Number(box);
      return matchesSearch && matchesBox;
    });
    words.sort((a, b) => {
      if (sort === 'mistakes') return b.mistakes - a.mistakes || a.number - b.number;
      if (sort === 'due') return (a.due || '9999').localeCompare(b.due || '9999') || a.number - b.number;
      if (sort === 'alpha') return a.term.localeCompare(b.term, 'en');
      return a.number - b.number;
    });
    const totalPages = Math.max(1, Math.ceil(words.length / PAGE_SIZE));
    wordsPage = clamp(wordsPage, 1, totalPages);
    const pageWords = words.slice((wordsPage - 1) * PAGE_SIZE, wordsPage * PAGE_SIZE);
    $('#wordCountLabel').textContent = `${faNumber.format(words.length)} کلمه`;
    $('#wordsTableBody').innerHTML = pageWords.length ? pageWords.map((word) => `<tr>
      <td class="word-cell">${escapeHtml(word.accepted.join(' / '))}</td><td>${escapeHtml(word.category)}</td>
      <td><span class="box-badge ${word.box ? '' : 'new'}">${word.box ? `خانهٔ ${faNumber.format(word.box)}` : 'وارد نشده'}</span></td>
      <td>${faNumber.format(word.attempts)}</td><td class="mistake-count">${faNumber.format(word.mistakes)}</td>
      <td>${word.due ? formatRelativeDay(word.due) : '—'}</td>
      <td><div class="row-menu">${word.box === 0 ? `<button class="mini-btn add-to-box-one" data-id="${word.id}" aria-label="افزودن ${escapeHtml(word.term)} به خانه ۱" title="افزودن به خانهٔ ۱">＋</button>` : ''}<button class="mini-btn listen-row" data-id="${word.id}" aria-label="تلفظ">▶</button><button class="mini-btn edit-row" data-id="${word.id}">ویرایش</button><button class="mini-btn delete delete-row" data-id="${word.id}">حذف</button></div></td>
    </tr>`).join('') : '<tr><td colspan="7" class="no-data">کلمه‌ای پیدا نشد.</td></tr>';
    $('#pageInfo').textContent = `صفحه ${faNumber.format(wordsPage)} از ${faNumber.format(totalPages)}`;
    $('#prevPage').disabled = wordsPage <= 1;
    $('#nextPage').disabled = wordsPage >= totalPages;
  }

  function formatRelativeDay(day) {
    const today = localDay();
    if (day < today) return 'عقب‌افتاده';
    if (day === today) return 'امروز';
    if (day === addDays(today, 1)) return 'فردا';
    return shortFaDate.format(new Date(`${day}T12:00:00`));
  }

  function openWordDialog(word = null) {
    $('#wordDialogTitle').textContent = word ? 'ویرایش کلمه' : 'افزودن کلمه';
    $('#editingWordId').value = word?.id || '';
    $('#wordTermInput').value = word?.term || '';
    $('#wordVariantsInput').value = word ? word.accepted.slice(1).join(' / ') : '';
    $('#wordCategoryInput').value = word?.category || '';
    $('#wordNotesInput').value = word?.notes || '';
    $('#wordDialog').showModal();
    setTimeout(() => $('#wordTermInput').focus(), 50);
  }

  function saveWordFromDialog(event) {
    event.preventDefault();
    const term = $('#wordTermInput').value.trim();
    if (!term) return;
    const variants = $('#wordVariantsInput').value.split(/\s*\/\s*/).map((item) => item.trim()).filter(Boolean);
    const id = $('#editingWordId').value;
    const existing = state.words.find((word) => word.id === id);
    if (existing) {
      existing.term = term;
      existing.accepted = [...new Set([term, ...variants])];
      existing.category = $('#wordCategoryInput').value.trim() || 'بدون دسته‌بندی';
      existing.notes = $('#wordNotesInput').value.trim();
    } else {
      state.words.push(createWord({ term, accepted: [term, ...variants], category: $('#wordCategoryInput').value.trim(), notes: $('#wordNotesInput').value.trim(), number: state.words.length + 1 }));
    }
    saveState();
    $('#wordDialog').close();
    renderWords();
    showToast(existing ? 'کلمه ویرایش شد.' : 'کلمه اضافه شد.');
  }

  function deleteWord(id) {
    const word = state.words.find((item) => item.id === id);
    if (!word || !confirm(`«${word.term}» حذف شود؟ تاریخچه‌ی این کلمه نیز دیگر در گزارش کلمه نمایش داده نمی‌شود.`)) return;
    state.words = state.words.filter((item) => item.id !== id);
    saveState();
    renderWords();
    renderGlobal();
    showToast('کلمه حذف شد.');
  }

  function renderReports() {
    renderGlobal();
    const stats = totalStats();
    const activeDays = Object.values(state.daily).filter((day) => day.attempts > 0).length;
    $('#reportAttempts').textContent = faNumber.format(stats.attempts);
    $('#reportCorrect').textContent = faNumber.format(stats.correct);
    $('#reportMistakes').textContent = faNumber.format(stats.mistakes);
    $('#reportActiveDays').textContent = faNumber.format(activeDays);
    renderAccuracyChart();
    renderProgressMetrics(stats, activeDays);
    const hardest = hardWords(30);
    $('#hardWordsTable').innerHTML = hardest.length ? hardest.map((word) => `<tr><td class="word-cell">${escapeHtml(word.term)}</td><td class="mistake-count">${faNumber.format(word.mistakes)}</td><td>${faNumber.format(word.attempts)}</td><td>${faNumber.format(accuracy(word.correct, word.attempts) || 0)}٪</td><td>${faNumber.format(word.box)}</td><td>${word.lastReviewed ? shortFaDate.format(new Date(word.lastReviewed)) : '—'}</td></tr>`).join('') : '<tr><td colspan="6" class="no-data">پس از مرور لغات، گزارش اینجا نمایش داده می‌شود.</td></tr>';
  }

  function renderAccuracyChart() {
    const days = Array.from({ length: 30 }, (_, index) => daysAgo(29 - index));
    const values = days.map((day) => {
      const record = state.daily[day];
      return record?.attempts ? Math.round((record.correct / record.attempts) * 100) : null;
    });
    const width = 700;
    const height = 220;
    const padding = { top: 15, right: 15, bottom: 28, left: 35 };
    const x = (index) => padding.left + (index / (days.length - 1)) * (width - padding.left - padding.right);
    const y = (value) => padding.top + ((100 - value) / 100) * (height - padding.top - padding.bottom);
    const points = values.map((value, index) => value === null ? null : { x: x(index), y: y(value), value, index });
    const segments = [];
    let current = [];
    points.forEach((point) => {
      if (point) current.push(point);
      else if (current.length) { segments.push(current); current = []; }
    });
    if (current.length) segments.push(current);
    const linePaths = segments.map((segment) => `<path class="chart-line" d="${segment.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')}"></path>${segment.map((point) => `<circle class="chart-dot" cx="${point.x}" cy="${point.y}" r="3"><title>${days[point.index]}: ${point.value}%</title></circle>`).join('')}`).join('');
    const grid = [0, 25, 50, 75, 100].map((value) => `<line class="chart-grid" x1="${padding.left}" x2="${width - padding.right}" y1="${y(value)}" y2="${y(value)}"></line><text class="chart-label" x="5" y="${y(value) + 3}">${value}%</text>`).join('');
    const labels = [0, 7, 14, 21, 29].map((index) => `<text class="chart-label" x="${x(index)}" y="${height - 5}" text-anchor="middle">${escapeHtml(shortFaDate.format(new Date(`${days[index]}T12:00:00`)))}</text>`).join('');
    $('#accuracyChart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="نمودار دقت سی روز اخیر">${grid}${linePaths}${labels}</svg>`;
  }

  function renderProgressMetrics(stats, activeDays) {
    const total = state.words.length || 1;
    const introduced = state.words.filter((word) => word.introducedOn).length;
    const metrics = [
      { label: 'آشنایی با فهرست', value: Math.round((introduced / total) * 100), detail: `${introduced} از ${state.words.length}` },
      { label: 'رسیدن به خانهٔ ۵', value: Math.round((stats.mastered / total) * 100), detail: `${stats.mastered} کلمه` },
      { label: 'دقت کلی', value: accuracy(stats.correct, stats.attempts) || 0, detail: `${stats.correct} پاسخ درست` },
      { label: 'پیوستگی تمرین', value: clamp(Math.round((calculateStreak() / 30) * 100), 0, 100), detail: `${calculateStreak()} روز پیوسته از ${activeDays} روز فعال` }
    ];
    $('#progressMetrics').innerHTML = metrics.map((metric) => `<div class="metric-row"><div class="row-between"><span>${metric.label}</span><strong>${faNumber.format(metric.value)}٪</strong></div><div class="progress-track"><i style="width:${metric.value}%"></i></div><small>${escapeHtml(metric.detail)}</small></div>`).join('');
  }

  function renderSettings() {
    renderGlobal();
    $('#dailyNewInput').value = state.settings.dailyNew;
    $('#dailyGoalInput').value = state.settings.dailyGoal;
    $('#voiceRateInput').value = state.settings.voiceRate;
    $('#voiceRateOutput').textContent = `${state.settings.voiceRate}×`;
  }

  function saveSettings() {
    state.settings.dailyNew = clamp(Number($('#dailyNewInput').value) || 10, 1, 50);
    state.settings.dailyGoal = clamp(Number($('#dailyGoalInput').value) || 20, 5, 200);
    state.settings.voiceRate = clamp(Number($('#voiceRateInput').value) || 0.85, 0.5, 1.2);
    ensureDailyWords();
    saveState();
    renderSettings();
    showToast('تنظیمات ذخیره شد.');
  }

  function buildAnalysisReport() {
    const stats = totalStats();
    const activeDays = Object.entries(state.daily).filter(([, value]) => value.attempts > 0);
    const boxDistribution = Object.fromEntries([0, 1, 2, 3, 4, 5].map((box) => [box === 0 ? 'new' : `box_${box}`, state.words.filter((word) => word.box === box).length]));
    return {
      reportType: 'Vazheyar IELTS Learning Analysis',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      instructionsForAI: 'Analyse progress, recurring spelling mistakes, hard words, consistency and accuracy. Reply in Persian with a short diagnosis and a practical 7-day drill.',
      schedulingRules: { dayBoundary: 'local midnight', box1: 'daily and unlimited free practice without promotion', box2To3Days: 2, box3To4Days: 3, box4To5Days: 7, box5ReviewDays: 14, wrongAnswer: 'return to box 1 and block promotion until next calendar day' },
      profile: {
        totalWords: state.words.length,
        introducedWords: state.words.filter((word) => word.introducedOn).length,
        masteredWords: stats.mastered,
        totalAttempts: stats.attempts,
        correctAnswers: stats.correct,
        mistakes: stats.mistakes,
        overallAccuracyPercent: accuracy(stats.correct, stats.attempts),
        activeDays: activeDays.length,
        currentStreakDays: calculateStreak(),
        dailyNewTarget: state.settings.dailyNew,
        dailyAnswerGoal: state.settings.dailyGoal
      },
      boxDistribution,
      last90Days: Object.fromEntries(Object.entries(state.daily).filter(([day]) => day >= daysAgo(89)).sort(([a], [b]) => a.localeCompare(b))),
      hardestWords: hardWords(100).map((word) => ({
        word: word.term, acceptedSpellings: word.accepted, category: word.category, box: word.box, addedSource: word.addedSource,
        attempts: word.attempts, correct: word.correct, mistakes: word.mistakes,
        accuracyPercent: accuracy(word.correct, word.attempts), mistakeRatePercent: word.attempts ? Math.round((word.mistakes / word.attempts) * 100) : 0,
        lastReviewed: word.lastReviewed, nextDue: word.due, blockedUntil: word.blockedUntil, note: word.notes || undefined
      })),
      recentMistakeEvents: state.history.filter((event) => !event.correct).slice(-250).map((event) => ({ at: event.at, word: event.term, typed: event.answer, mode: event.mode || 'legacy', mistakeNumber: event.mistakeNumber, previousBox: event.previousBox }))
    };
  }

  function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    downloadBlob(blob, filename);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function restoreBackup(text) {
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.words) || !parsed.settings || !parsed.daily) throw new Error('ساختار فایل پشتیبان معتبر نیست.');
    if (!confirm(`پشتیبان شامل ${parsed.words.length} کلمه است. داده‌های فعلی جایگزین شود؟`)) return false;
    const sourceVersion = Number(parsed.schemaVersion) || 1;
    state = {
      ...defaultState(), ...parsed, schemaVersion: SCHEMA_VERSION,
      settings: { ...defaultState().settings, ...parsed.settings }, words: parsed.words.map(createWord), daily: parsed.daily || {}, history: Array.isArray(parsed.history) ? parsed.history : []
    };
    if (sourceVersion < 2) migrateLegacyProgress(state);
    ensureDailyWords();
    saveState();
    renderAll();
    return true;
  }

  function resetProgress() {
    if (!confirm('همه‌ی پیشرفت‌ها، خطاها و تاریخچه پاک شود؟ این کار قابل بازگشت نیست مگر پشتیبان داشته باشی.')) return;
    const keepWords = state.words.map((word, index) => createWord({ number: word.number || index + 1, term: word.term, accepted: word.accepted, category: word.category, notes: word.notes }));
    state = defaultState();
    state.words = keepWords;
    ensureDailyWords();
    saveState();
    renderAll();
    showToast('پیشرفت‌ها پاک شد.');
  }

  function showToast(message, isError = false) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.style.background = isError ? 'var(--danger)' : '';
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.classList.remove('show'); toast.style.background = ''; }, 3200);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  }

  function bindEvents() {
    $$('.nav-item').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
    $$('[data-go]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.go)));
    $('#themeToggle').addEventListener('click', cycleTheme);
    $('#startReviewBtn').addEventListener('click', () => showView('review'));
    $('#boxOnePracticeBtn').addEventListener('click', () => { showView('review'); setTimeout(() => startSession('box1'), 50); });
    $('#addNewWordsBtn').addEventListener('click', openNewWordsDialog);
    $('#newWordsForm').addEventListener('submit', startSelectedNewWords);
    $$('.close-new-words-dialog').forEach((button) => button.addEventListener('click', () => $('#newWordsDialog').close()));
    $('#beginSessionBtn').addEventListener('click', () => startSession('scheduled'));
    $('#practiceExtraBtn').addEventListener('click', () => startSession('box1'));
    $('#exitSessionBtn').addEventListener('click', exitSession);
    $('#listenWordBtn').addEventListener('click', () => speakWord(1));
    $('#slowListenBtn').addEventListener('click', () => speakWord(0.7));
    $('#answerForm').addEventListener('submit', (event) => { event.preventDefault(); submitAnswer($('#answerInput').value); });
    $('#dontKnowBtn').addEventListener('click', () => submitAnswer('', true));
    $('#nextCardBtn').addEventListener('click', showNextCard);

    $('#wordSearch').addEventListener('input', () => { wordsPage = 1; renderWords(); });
    $('#boxFilter').addEventListener('change', () => { wordsPage = 1; renderWords(); });
    $('#sortWords').addEventListener('change', () => { wordsPage = 1; renderWords(); });
    $('#prevPage').addEventListener('click', () => { wordsPage -= 1; renderWords(); });
    $('#nextPage').addEventListener('click', () => { wordsPage += 1; renderWords(); });
    $('#addWordBtn').addEventListener('click', () => openWordDialog());
    $('#wordForm').addEventListener('submit', saveWordFromDialog);
    $$('.close-word-dialog').forEach((button) => button.addEventListener('click', () => $('#wordDialog').close()));
    $('#wordsTableBody').addEventListener('click', (event) => {
      const button = event.target.closest('[data-id]');
      if (!button) return;
      const word = state.words.find((item) => item.id === button.dataset.id);
      if (button.classList.contains('edit-row')) openWordDialog(word);
      if (button.classList.contains('delete-row')) deleteWord(button.dataset.id);
      if (button.classList.contains('add-to-box-one')) addWordToBoxOne(button.dataset.id);
      if (button.classList.contains('listen-row') && word) { currentWord = word; speakWord(1); }
    });

    $('#importWordsBtn').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const result = importWords(await file.text());
        showToast(`${faNumber.format(result.added)} کلمه اضافه و ${faNumber.format(result.skipped)} تکراری رد شد.`);
      } catch (error) { showToast(error.message, true); }
      event.target.value = '';
    });

    $('#voiceRateInput').addEventListener('input', () => { $('#voiceRateOutput').textContent = `${$('#voiceRateInput').value}×`; });
    $('#saveSettingsBtn').addEventListener('click', saveSettings);
    $('#exportAnalysisBtn').addEventListener('click', () => { downloadJson(buildAnalysisReport(), `vazheyar-analysis-${localDay()}.json`); showToast('خروجی تحلیل آماده شد؛ همین فایل را برای من بفرست.'); });
    $('#exportBackupBtn').addEventListener('click', () => { downloadJson(state, `vazheyar-backup-${localDay()}.json`); showToast('پشتیبان کامل دریافت شد.'); });
    $('#restoreBackupBtn').addEventListener('click', () => $('#backupInput').click());
    $('#backupInput').addEventListener('change', async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try { if (restoreBackup(await file.text())) showToast('پشتیبان با موفقیت بازیابی شد.'); }
      catch (error) { showToast(error.message, true); }
      event.target.value = '';
    });
    $('#resetDataBtn').addEventListener('click', resetProgress);
    window.addEventListener('hashchange', () => {
      const target = location.hash.slice(1);
      if (['dashboard', 'review', 'words', 'reports', 'settings'].includes(target) && target !== currentView) showView(target);
    });
    document.addEventListener('keydown', (event) => {
      if (currentView !== 'review' || $('#reviewSession').classList.contains('hidden')) return;
      if (event.key === ' ' && document.activeElement !== $('#answerInput') && !feedbackOpen) { event.preventDefault(); speakWord(1); }
      if (event.key === 'Enter' && feedbackOpen) { event.preventDefault(); showNextCard(); }
    });
  }

  function renderAll() {
    applyTheme();
    renderGlobal();
    if (currentView === 'dashboard') renderDashboard();
    if (currentView === 'review') renderReviewSetup();
    if (currentView === 'words') renderWords();
    if (currentView === 'reports') renderReports();
    if (currentView === 'settings') renderSettings();
  }

  function init() {
    applyTheme();
    ensureDailyWords();
    saveState();
    bindEvents();
    const initialView = ['dashboard', 'review', 'words', 'reports', 'settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard';
    showView(initialView);
    window.VazheyarTest = { normalizeAnswer, isCorrectAnswer, parseWordFile, addDays, localDay, buildAnalysisReport, migrateLegacyProgress, weightedBoxOneBatch, getCurrentWord: () => currentWord };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
