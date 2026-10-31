import { LEVELS, scorePercentage, qualifiesToUnlock, unlockedLevelsAfterFinal, nextLevel, progressKey, shuffle } from './core.js';
import { openDatabase, loadUserData, saveWordProgress, saveMeta, saveQuizResult, replaceUserData } from './db.js';

const DATA_URL = './data/oxford3000.json';
const DEFAULT_QUESTION_COUNT = 20;
const REVIEW_INTERVAL_DAYS = [1, 3, 7, 14, 30];
const LEVEL_NAMES = { A1: 'مبتدئ', A2: 'أساسي', B1: 'متوسط', B2: 'فوق المتوسط' };
const LEVEL_COLORS = { A1: 'mint', A2: 'blue', B1: 'violet', B2: 'amber' };
const POS_AR = {
  'n.': 'اسم', 'v.': 'فعل', 'adj.': 'صفة', 'adv.': 'ظرف', 'prep.': 'حرف جر',
  'pron.': 'ضمير', 'det.': 'محدد', 'conj.': 'أداة ربط', 'exclam.': 'تعجب',
  'number': 'عدد', 'indefinite article': 'أداة نكرة', 'definite article': 'أداة تعريف',
  'modal v.': 'فعل مساعد ناقص', 'auxiliary v.': 'فعل مساعد', 'infinitive marker': 'علامة المصدر'
};

const ui = {
  view: document.getElementById('viewRoot'),
  title: document.getElementById('pageTitle'),
  eyebrow: document.getElementById('pageEyebrow'),
  toast: document.getElementById('toastRegion'),
  modal: document.getElementById('modalRoot'),
  errorCount: document.getElementById('errorNavCount'),
  install: document.getElementById('installButton'),
  connection: document.getElementById('connectionStatus'),
  backupFile: document.getElementById('backupFile')
};

const app = {
  db: null,
  words: [],
  progress: new Map(),
  meta: null,
  history: [],
  section: 'home',
  level: 'A1',
  filter: 'all',
  search: '',
  wordPage: 0,
  activeQuiz: null,
  installPrompt: null,
  voices: [],
  englishVoice: null,
  arabicVoice: null,
  persistenceReady: false
};

const sectionTitles = {
  home: ['مساحة التعلّم الشخصية', 'لوحة التقدم'],
  levels: ['خطتك خطوة بخطوة', 'المستويات'],
  learn: ['تعلّم بالممارسة اليومية', 'مكتبة الكلمات'],
  quiz: ['اختبر ما تعلمته', 'مركز الاختبارات'],
  errors: ['حوّل الخطأ إلى معرفة', 'مراجعة الأخطاء'],
  favorites: ['مفرداتك المختارة', 'الكلمات المفضلة'],
  stats: ['راقب تقدّمك بوضوح', 'إحصائيات التعلّم'],
  settings: ['بياناتك محفوظة على جهازك', 'الإعدادات والنسخ الاحتياطي']
};

function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ar-JO', { dateStyle: 'medium' }).format(new Date(value));
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  ui.toast.append(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

function byId(id) {
  return app.words.find(word => word.id === id);
}

function progressId(wordId, level) {
  return progressKey(wordId, level);
}

function getProgress(word, level = app.level) {
  const id = progressId(word.id, level);
  return app.progress.get(id) || {
    id, wordId: word.id, level, status: 'new', favorite: false,
    attempts: 0, correctCount: 0, wrongCount: 0, correctStreak: 0,
    reviewCorrectStreak: 0, needsReview: false, nextReviewAt: null,
    lastSeenAt: null, translationOverride: '', exampleEnglish: '', exampleArabic: ''
  };
}

function saveProgress(record) {
  app.progress.set(record.id, record);
  return saveWordProgress(app.db, record).catch(() => showToast('تعذّر حفظ التغييرات في قاعدة البيانات.', 'error'));
}

function getLevelWords(level) {
  return app.words.filter(word => word.levels.includes(level));
}

function getAllLevelRecords(level = app.level) {
  return getLevelWords(level).map(word => ({ word, level }));
}

function currentPos(word, level) {
  const forms = word.forms.filter(form => form.level === level).map(form => form.partOfSpeech);
  return [...new Set(forms)].join(' · ') || 'غير محدد في المصدر';
}

function currentGloss(word, level = app.level) {
  const progress = getProgress(word, level);
  if (progress.translationOverride.trim()) return progress.translationOverride.trim();
  return word.meanings.join(' ؛ ');
}

function glossStatus(word, level = app.level) {
  const progress = getProgress(word, level);
  if (progress.translationOverride.trim()) return 'أضفتها أو راجعتها بنفسك';
  if (word.meanings.length) return 'ترجمة مبدئية من الموقع السابق · تحتاج تدقيقًا';
  return 'الترجمة لم تُستكمل بعد';
}

function statusLabel(progress) {
  if (progress.needsReview || progress.status === 'review') return 'تحتاج مراجعة';
  if (progress.status === 'mastered') return 'متقنة';
  return 'جديدة';
}

function levelPercent(level) {
  const words = getLevelWords(level);
  if (!words.length) return 0;
  const mastered = words.filter(word => getProgress(word, level).status === 'mastered').length;
  return Math.round((mastered / words.length) * 100);
}

function totalStats() {
  const opened = app.meta.unlockedLevels || ['A1'];
  let total = 0, mastered = 0, review = 0, favorites = 0, touched = 0;
  for (const level of opened) {
    for (const word of getLevelWords(level)) {
      total += 1;
      const p = getProgress(word, level);
      if (p.status === 'mastered') mastered += 1;
      if (p.needsReview || p.status === 'review' || (p.nextReviewAt && new Date(p.nextReviewAt).getTime() <= Date.now())) review += 1;
      if (p.favorite) favorites += 1;
      if (p.status !== 'new' || p.attempts > 0) touched += 1;
    }
  }
  return { total, mastered, review, favorites, touched, percent: total ? Math.round(mastered / total * 100) : 0 };
}

function updateSidebar() {
  const stats = totalStats();
  const percent = document.getElementById('sideProgressPercent');
  const bar = document.getElementById('sideProgressBar');
  const text = document.getElementById('sideProgressText');
  if (percent) percent.textContent = `${stats.percent}%`;
  if (bar) bar.style.width = `${stats.percent}%`;
  if (text) text.textContent = `${stats.mastered.toLocaleString('ar-JO')} كلمة متقنة من ${stats.total.toLocaleString('ar-JO')} ضمن المستويات المفتوحة`;
  ui.errorCount.textContent = countReviewWords().toLocaleString('ar-JO');
}

function countReviewWords() {
  let count = 0;
  const now = Date.now();
  for (const value of app.progress.values()) {
    if (value.needsReview || value.status === 'review' || (value.nextReviewAt && new Date(value.nextReviewAt).getTime() <= now)) count += 1;
  }
  return count;
}

function setSection(section) {
  if (!sectionTitles[section]) return;
  app.section = section;
  if (app.meta) {
    app.meta.lastVisited = { section, level: app.level, wordId: null, at: new Date().toISOString() };
    saveMeta(app.db, app.meta).catch(() => {});
  }
  render();
}

function openLevel(level) {
  if (!app.meta.unlockedLevels.includes(level)) {
    showToast('هذا المستوى مغلق. اجتز الاختبار النهائي للمستوى السابق بنسبة 90% أو أكثر.', 'warning');
    return;
  }
  app.level = level;
  app.filter = 'all';
  app.search = '';
  app.wordPage = 0;
  app.section = 'learn';
  app.meta.lastVisited = { section: 'learn', level, wordId: null, at: new Date().toISOString() };
  saveMeta(app.db, app.meta).catch(() => {});
  render();
}

function renderNav() {
  document.querySelectorAll('.nav-link[data-section]').forEach(button => {
    button.classList.toggle('active', button.dataset.section === app.section);
  });
  const [eyebrow, title] = sectionTitles[app.section] || sectionTitles.home;
  ui.eyebrow.textContent = eyebrow;
  ui.title.textContent = title;
  const strip = document.getElementById('mobileNavStrip');
  const short = [
    ['home', 'الرئيسية'], ['levels', 'المستويات'], ['learn', 'الكلمات'],
    ['quiz', 'الاختبارات'], ['errors', 'المراجعة']
  ];
  strip.innerHTML = short.map(([id, label]) => `<button class="mobile-nav-item ${app.section === id ? 'active' : ''}" data-section="${id}">${label}</button>`).join('');
}

function render() {
  renderNav();
  updateSidebar();
  const renderers = {
    home: renderHome,
    levels: renderLevels,
    learn: renderLearn,
    quiz: renderQuizLanding,
    errors: renderErrors,
    favorites: renderFavorites,
    stats: renderStats,
    settings: renderSettings
  };
  (renderers[app.section] || renderHome)();
  updateVoiceButtons();
}

function renderHome() {
  const stats = totalStats();
  const openCount = app.meta.unlockedLevels.length;
  const current = app.meta.lastVisited?.level || 'A1';
  const levelCards = LEVELS.map(level => {
    const unlocked = app.meta.unlockedLevels.includes(level);
    const count = getLevelWords(level).length;
    return `<article class="level-card level-${LEVEL_COLORS[level]} ${unlocked ? '' : 'locked'}">
      <div class="level-card-top"><span class="level-symbol">${level}</span><span class="level-state">${unlocked ? '<i class="state-dot"></i> متاح' : '🔒 مغلق'}</span></div>
      <h3>${LEVEL_NAMES[level]}</h3><p>${count.toLocaleString('ar-JO')} مدخل ضمن هذا المستوى</p>
      <div class="level-meter"><span style="width:${unlocked ? levelPercent(level) : 0}%"></span></div>
      <div class="level-card-bottom"><small>${unlocked ? `${levelPercent(level)}% منجز` : 'اجتز المستوى السابق لفتحه'}</small>
      <button class="text-arrow" data-action="open-level" data-level="${level}" ${unlocked ? '' : 'disabled'}>${unlocked ? 'تابع التعلّم ←' : 'مقفل'}</button></div>
    </article>`;
  }).join('');

  ui.view.innerHTML = `
    <div class="welcome-hero">
      <div class="hero-copy"><div class="hero-overline"><span class="hero-pulse"></span> رحلتك تبدأ من كلمة</div>
        <h1>كل كلمة تتعلمها،<br><em>تفتح لك بابًا جديدًا.</em></h1>
        <p>من A1 إلى B2، ابنِ حصيلتك الإنجليزية خطوة بخطوة عبر مفردات Oxford 3000 واختبارات تقيس تقدّمك الحقيقي.</p>
        <div class="hero-actions"><button class="button button-primary" data-action="open-level" data-level="${current}">متابعة التعلّم <span>←</span></button><button class="button button-ghost" data-section="levels">استكشف المستويات</button></div>
      </div>
      <div class="hero-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="orbit-core"><span>LEX</span><b>3000</b></div><div class="floating-word floating-one">learn</div><div class="floating-word floating-two">progress</div><div class="floating-word floating-three">achieve</div></div>
    </div>

    <div class="section-heading"><div><span class="section-kicker">نظرة عامة</span><h2>ملخص رحلتك</h2></div><span class="muted-note">تُحدّث الأرقام تلقائيًا بعد كل نشاط</span></div>
    <div class="stats-grid">
      <article class="stat-tile"><span class="stat-icon icon-indigo">▤</span><div><strong>${stats.total.toLocaleString('ar-JO')}</strong><small>كلمات ضمن المستويات المفتوحة</small></div></article>
      <article class="stat-tile"><span class="stat-icon icon-green">✓</span><div><strong>${stats.mastered.toLocaleString('ar-JO')}</strong><small>كلمات متقنة</small></div></article>
      <article class="stat-tile"><span class="stat-icon icon-amber">↻</span><div><strong>${stats.review.toLocaleString('ar-JO')}</strong><small>كلمات تحتاج مراجعة</small></div></article>
      <article class="stat-tile"><span class="stat-icon icon-rose">♡</span><div><strong>${stats.favorites.toLocaleString('ar-JO')}</strong><small>كلمات في المفضلة</small></div></article>
    </div>

    <div class="section-heading section-heading-spaced"><div><span class="section-kicker">المسار الدراسي</span><h2>مستويات Oxford</h2></div><button class="text-arrow" data-section="levels">عرض جميع المستويات ←</button></div>
    <div class="level-grid">${levelCards}</div>

    <div class="home-lower-grid"><article class="panel-card continue-card"><div class="panel-topline"><span class="section-kicker">نقطة العودة</span><span class="soft-chip">${current}</span></div><h3>جاهز تكمل من حيث توقفت؟</h3><p>تابع الكلمات الجديدة أو انتقل إلى مراجعة المفردات التي تحتاج إلى تثبيت.</p><div class="continue-actions"><button class="button button-primary" data-action="open-level" data-level="${current}">العودة إلى ${current}</button><button class="button button-soft" data-section="errors">مراجعة الأخطاء</button></div></article>
      <article class="panel-card focus-card"><span class="section-kicker">هدف اليوم</span><div class="focus-number">${Math.min(15, Math.max(0, getLevelWords(current).filter(w => getProgress(w,current).status==='new').length)).toLocaleString('ar-JO')} <small>كلمة مقترحة</small></div><p>ابدأ بمجموعة قصيرة، ثم اختبر تذكّرك قبل الانتقال إلى مجموعة جديدة.</p><button class="button button-dark" data-section="learn">ابدأ جلسة الكلمات ←</button></article></div>
  `;
}

function renderLevels() {
  const cards = LEVELS.map((level, index) => {
    const unlocked = app.meta.unlockedLevels.includes(level);
    const words = getLevelWords(level);
    const mastered = words.filter(word => getProgress(word, level).status === 'mastered').length;
    const progress = words.length ? Math.round(mastered / words.length * 100) : 0;
    return `<article class="level-detail-card ${unlocked ? 'is-open' : 'is-locked'}">
      <div class="level-detail-head"><span class="level-number ${LEVEL_COLORS[level]}">${level}</span><span class="level-state-pill ${unlocked ? 'open' : 'closed'}">${unlocked ? 'مفتوح' : 'مغلق'}</span></div>
      <div class="level-detail-title"><div><h3>${LEVEL_NAMES[level]}</h3><p>${index === 0 ? 'الأساس الأول للمفردات اليومية' : index === 1 ? 'توسيع المفردات والتعبير الأساسي' : index === 2 ? 'فهم أوسع واستخدام أكثر استقلالية' : 'مفردات أكثر دقة وتنوعًا'}</p></div><strong>${words.length.toLocaleString('ar-JO')}<small> مدخل</small></strong></div>
      <div class="level-detail-progress"><div><span>التقدم</span><b>${unlocked ? `${progress}%` : '—'}</b></div><div class="wide-progress"><span style="width:${unlocked ? progress : 0}%"></span></div></div>
      <div class="level-detail-footer"><small>${unlocked ? `${mastered.toLocaleString('ar-JO')} من ${words.length.toLocaleString('ar-JO')} متقنة` : `يتطلب ${index === 0 ? 'فتحًا أوليًا' : '90% على الأقل في الاختبار النهائي للمستوى السابق'}`}</small><button class="button ${unlocked ? 'button-primary' : 'button-disabled'}" data-action="open-level" data-level="${level}" ${unlocked ? '' : 'disabled'}>${unlocked ? 'دخول المستوى' : '🔒 غير متاح'}</button></div>
    </article>`;
  }).join('');
  ui.view.innerHTML = `<div class="page-intro"><div><span class="section-kicker">مسار تدريجي</span><h1>أربعة مستويات، خطوة واحدة كل مرة.</h1><p>ابدأ بـ A1. عند تحقيق 90% أو أكثر في الاختبار النهائي، يُفتح المستوى التالي تلقائيًا ويظل مفتوحًا بعد ذلك.</p></div><div class="intro-stat"><strong>${app.meta.unlockedLevels.length}/4</strong><span>مستويات مفتوحة</span></div></div>
    <div class="level-detail-grid">${cards}</div><div class="notice-panel"><span class="notice-icon">ⓘ</span><div><strong>كيف يعمل الفتح؟</strong><p>درجة 89% لا تفتح المستوى التالي. درجة 90% أو 91% أو 95% أو 100% تفتحه، ولا تحتاج إلى إعادة الاختبار لفتح مستوى سبق فتحه.</p></div></div>`;
}

function filterRecords(records, filter, search) {
  const term = search.trim().toLocaleLowerCase();
  return records.filter(({ word, level }) => {
    const p = getProgress(word, level);
    const gloss = currentGloss(word, level);
    const matchesSearch = !term || [word.headword, word.searchHeadword, gloss, currentPos(word, level)].some(value => String(value || '').toLocaleLowerCase().includes(term));
    if (!matchesSearch) return false;
    if (filter === 'new') return p.status === 'new' && p.attempts === 0;
    if (filter === 'mastered') return p.status === 'mastered';
    if (filter === 'review') return p.needsReview || p.status === 'review' || (p.nextReviewAt && new Date(p.nextReviewAt) <= new Date());
    if (filter === 'favorites') return p.favorite;
    return true;
  });
}

function renderWordCard({ word, level }) {
  const p = getProgress(word, level);
  const gloss = currentGloss(word, level);
  const status = statusLabel(p);
  const exampleEn = p.exampleEnglish || word.exampleEnglish || '';
  const exampleAr = p.exampleArabic || word.exampleArabic || '';
  return `<article class="word-card ${p.status === 'mastered' ? 'word-mastered' : ''}" data-word-card="${word.id}">
    <div class="word-card-top"><span class="word-level-tag">${level}</span><span class="word-status status-${p.status}">${status}</span></div>
    <div class="word-main"><div><h3 lang="en" dir="ltr">${escapeHTML(word.headword)}</h3><span class="word-pos" title="التصنيف كما ورد في Oxford">${escapeHTML(currentPos(word, level))}</span></div><button class="favorite-button ${p.favorite ? 'favorited' : ''}" data-action="favorite" data-word-id="${word.id}" data-level="${level}" title="${p.favorite ? 'إزالة من المفضلة' : 'إضافة للمفضلة'}">${p.favorite ? '♥' : '♡'}</button></div>
    <div class="word-translation"><span>المعنى العربي</span><strong>${gloss ? escapeHTML(gloss) : '<em>لم تُستكمل الترجمة بعد</em>'}</strong><small>${escapeHTML(glossStatus(word, level))}</small></div>
    <div class="word-example">${exampleEn ? `<p dir="ltr" lang="en">${escapeHTML(exampleEn)}</p><small>${escapeHTML(exampleAr)}</small>` : `<p class="example-pending">لا يوجد مثال مراجع لهذه المفردة بعد.</p>`}</div>
    <div class="word-card-actions"><button class="mini-action speak-en" data-action="speak-en" data-word-id="${word.id}" data-level="${level}" hidden>◖ نطق إنجليزي</button><button class="mini-action speak-ar" data-action="speak-ar" data-word-id="${word.id}" data-level="${level}" hidden>◖ نطق عربي</button>
      <button class="mini-action" data-action="edit-word" data-word-id="${word.id}" data-level="${level}">✎ تحرير المعنى والمثال</button>
      <button class="mini-action ${p.status === 'mastered' ? 'mini-active' : ''}" data-action="toggle-mastered" data-word-id="${word.id}" data-level="${level}">${p.status === 'mastered' ? '✓ متقنة' : '✓ أتقنتها'}</button>
      <button class="mini-action ${p.status === 'review' ? 'mini-review' : ''}" data-action="mark-review" data-word-id="${word.id}" data-level="${level}">↻ تحتاج مراجعة</button></div>
  </article>`;
}

function renderLearn() {
  const records = getAllLevelRecords(app.level);
  const filtered = filterRecords(records, app.filter, app.search);
  const pageSize = 30;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  app.wordPage = Math.min(app.wordPage, pageCount - 1);
  const visible = filtered.slice(app.wordPage * pageSize, (app.wordPage + 1) * pageSize);
  const progress = getLevelProgressSummary(app.level);
  const filters = [
    ['all','الكل'], ['new','جديدة'], ['mastered','متقنة'], ['review','تحتاج مراجعة'], ['favorites','المفضلة']
  ];
  const levelOptions = LEVELS.filter(level => app.meta.unlockedLevels.includes(level)).map(level => `<option value="${level}" ${level === app.level ? 'selected' : ''}>${level} · ${LEVEL_NAMES[level]}</option>`).join('');
  ui.view.innerHTML = `<div class="section-top-row"><div><span class="section-kicker">مكتبة المفردات</span><h1>تعلّم كلمة، ثم استخدمها.</h1><p>تصفّح كلمات المستوى وعلّم ما أتقنته أو أضفه إلى قائمة المراجعة.</p></div><div class="level-picker-wrap"><label for="learnLevel">المستوى الحالي</label><select id="learnLevel" class="select-control">${levelOptions}</select></div></div>
    <div class="learn-progress-panel"><div class="learn-progress-copy"><div><span>تقدم ${app.level}</span><strong>${progress.percent}%</strong></div><p>${progress.mastered.toLocaleString('ar-JO')} كلمة متقنة من ${progress.total.toLocaleString('ar-JO')}</p></div><div class="wide-progress"><span style="width:${progress.percent}%"></span></div><div class="learn-progress-meta"><span>${progress.newCount.toLocaleString('ar-JO')} جديدة</span><span>${progress.review.toLocaleString('ar-JO')} للمراجعة</span></div></div>
    <div class="word-tools"><div class="search-wrap"><span>⌕</span><input id="wordSearch" type="search" value="${escapeHTML(app.search)}" placeholder="ابحث بالإنجليزية أو العربية أو نوع الكلمة…" autocomplete="off"></div><span class="result-count">${filtered.length.toLocaleString('ar-JO')} نتيجة</span></div>
    <div class="filter-row">${filters.map(([key,label]) => `<button class="filter-chip ${app.filter === key ? 'active' : ''}" data-filter="${key}">${label}${key==='favorites' ? ` (${progress.favorites})` : ''}</button>`).join('')}</div>
    ${visible.length ? `<div class="word-grid">${visible.map(renderWordCard).join('')}</div>` : `<div class="empty-state"><div class="empty-icon">⌕</div><h3>لا توجد كلمات مطابقة</h3><p>غيّر البحث أو اختر تصنيفًا آخر.</p><button class="button button-soft" data-action="clear-filters">إظهار جميع الكلمات</button></div>`}
    ${filtered.length > pageSize ? `<div class="pagination"><button class="button button-soft" data-action="word-page" data-delta="-1" ${app.wordPage===0?'disabled':''}>السابق</button><span>صفحة ${(app.wordPage+1).toLocaleString('ar-JO')} من ${pageCount.toLocaleString('ar-JO')}</span><button class="button button-soft" data-action="word-page" data-delta="1" ${app.wordPage>=pageCount-1?'disabled':''}>التالي</button></div>` : ''}
    <div class="source-footnote">التصنيف النحوي والمستوى مأخوذان من عمود Oxford الأصلي. الترجمات القديمة موسومة بأنها مبدئية حتى تتم مراجعتها.</div>`;
}

function getLevelProgressSummary(level) {
  const words = getLevelWords(level);
  const items = words.map(word => getProgress(word, level));
  return {
    total: words.length,
    mastered: items.filter(p => p.status === 'mastered').length,
    newCount: items.filter(p => p.status === 'new' && p.attempts === 0).length,
    review: items.filter(p => p.needsReview || p.status === 'review' || (p.nextReviewAt && new Date(p.nextReviewAt) <= new Date())).length,
    favorites: items.filter(p => p.favorite).length,
    percent: words.length ? Math.round(items.filter(p => p.status === 'mastered').length / words.length * 100) : 0
  };
}

function renderQuizLanding() {
  const unlocked = app.meta.unlockedLevels;
  const options = unlocked.map(level => `<option value="${level}" ${level === app.level ? 'selected' : ''}>${level} · ${LEVEL_NAMES[level]}</option>`).join('');
  const recent = app.history.slice(0, 5);
  ui.view.innerHTML = `<div class="page-intro"><div><span class="section-kicker">مركز التحدي</span><h1>اختبر ذاكرتك، لا تخمّن.</h1><p>تتغيّر الأسئلة عشوائيًا، ولا يتكرر المدخل داخل الاختبار الواحد. الاختبار النهائي يعتمد جولات تغطي مفردات المستوى بالتتابع.</p></div><div class="quiz-stamp"><span>90%</span><small>حد النجاح</small></div></div>
    <div class="quiz-config panel-card"><div class="quiz-config-heading"><div><span class="section-kicker">إعداد الاختبار</span><h2>اختر المستوى ونوع الجلسة</h2></div><span class="soft-chip">${unlocked.length} مستوى متاح</span></div>
      <div class="quiz-config-grid"><div><label for="quizLevel">المستوى</label><select id="quizLevel" class="select-control">${options}</select></div><div><label for="quizCount">عدد الأسئلة</label><select id="quizCount" class="select-control"><option value="10">10 أسئلة</option><option value="20" selected>20 سؤالًا</option><option value="30">30 سؤالًا</option><option value="50">50 سؤالًا</option></select></div><div class="quiz-ready-note"><strong>أنواع الأسئلة</strong><p>المعنى، الكلمة، إكمال الحروف، نوع الكلمة، والاستماع عند توفر صوت محلي.</p></div></div>
      <div class="quiz-mode-grid"><article class="quiz-mode-card"><span class="mode-symbol mode-practice">✎</span><h3>تدريب متنوع</h3><p>تدرب على مجموعة عشوائية من مفردات المستوى وتعرّف على تصحيح كل إجابة.</p><button class="button button-primary" data-action="start-quiz" data-kind="practice">ابدأ التدريب ←</button></article>
        <article class="quiz-mode-card featured-mode"><span class="mode-symbol mode-final">◆</span><span class="featured-label">لفتح المستوى التالي</span><h3>الاختبار النهائي</h3><p>عند الحصول على 90% أو أكثر، يُفتح المستوى التالي تلقائيًا ويتم حفظ النتيجة.</p><button class="button button-dark" data-action="start-quiz" data-kind="final">ابدأ الاختبار النهائي ←</button></article>
        <article class="quiz-mode-card"><span class="mode-symbol mode-review">↻</span><h3>اختبار الأخطاء</h3><p>أعد اختبار الكلمات التي أخطأت فيها. ثلاث إجابات صحيحة متتالية عبر جلسات مختلفة تزيل الكلمة من قائمة الأخطاء.</p><button class="button button-soft" data-action="start-quiz" data-kind="errors" ${countReviewWords() ? '' : 'disabled'}>اختبر الكلمات الخاطئة ←</button></article></div>
    </div>
    <div class="section-heading section-heading-spaced"><div><span class="section-kicker">سجلّك</span><h2>آخر نتائج الاختبارات</h2></div><span class="muted-note">${app.history.length.toLocaleString('ar-JO')} اختبار محفوظ</span></div>
    ${recent.length ? `<div class="history-list">${recent.map(historyItemHTML).join('')}</div>` : `<div class="empty-state compact-empty"><div class="empty-icon">✦</div><h3>لم تبدأ أول اختبار بعد</h3><p>أكمل بعض الكلمات ثم ابدأ تدريبك الأول.</p></div>`}`;
}

function historyItemHTML(item) {
  const percentage = Number(item.scorePercentage) || 0;
  const name = item.kind === 'final' ? 'اختبار نهائي' : item.kind === 'errors' ? 'اختبار الأخطاء' : 'تدريب';
  return `<div class="history-row"><div class="history-mark ${percentage >= 90 ? 'passed' : 'not-passed'}">${percentage >= 90 ? '✓' : '•'}</div><div class="history-name"><strong>${name} · ${item.level}</strong><small>${formatDate(item.date)} · ${item.total} سؤال</small></div><div class="history-score"><strong>${percentage}%</strong><small>${item.correct} صحيحة · ${item.wrong} خاطئة</small></div></div>`;
}

function renderErrors() {
  const records = [];
  for (const [key, p] of app.progress.entries()) {
    const due = p.nextReviewAt && new Date(p.nextReviewAt) <= new Date();
    if (!p.needsReview && p.status !== 'review' && !due) continue;
    const word = byId(p.wordId);
    if (word) records.push({ word, level: p.level, progress: p });
  }
  records.sort((a,b) => (b.progress.wrongCount || 0) - (a.progress.wrongCount || 0));
  ui.view.innerHTML = `<div class="page-intro"><div><span class="section-kicker">مراجعة ذكية</span><h1>الكلمات التي تستحق انتباهك.</h1><p>تُضاف الكلمة إلى هذه القائمة عند الخطأ. بعد ثلاث إجابات صحيحة متتالية في جلسات مراجعة منفصلة، تُزال من قائمة الأخطاء وتُسجّل كمتقنة.</p></div><div class="intro-stat error-stat"><strong>${records.length.toLocaleString('ar-JO')}</strong><span>كلمة للمراجعة</span></div></div>
    ${records.length ? `<div class="review-toolbar"><div><strong>قائمة المراجعة</strong><small>مرتبة حسب عدد مرات الخطأ</small></div><button class="button button-primary" data-action="start-quiz" data-kind="errors">ابدأ اختبار المراجعة ←</button></div><div class="word-grid">${records.map(({word,level}) => renderWordCard({word,level})).join('')}</div>` : `<div class="empty-state"><div class="empty-icon success-empty">✓</div><h3>قائمة الأخطاء فارغة</h3><p>أحسنت! لا توجد كلمات معلّمة للمراجعة حاليًا. ستظهر هنا تلقائيًا أي كلمة تخطئ فيها أثناء الاختبارات.</p><button class="button button-primary" data-section="quiz">اذهب إلى الاختبارات</button></div>`}`;
}

function collectFlaggedRecords(predicate) {
  const result = [];
  for (const [id, p] of app.progress.entries()) {
    if (!predicate(p)) continue;
    const word = byId(p.wordId);
    if (word) result.push({ word, level: p.level });
  }
  return result;
}

function renderFavorites() {
  const records = collectFlaggedRecords(p => p.favorite);
  ui.view.innerHTML = `<div class="page-intro"><div><span class="section-kicker">مفرداتك الشخصية</span><h1>احتفظ بالكلمات المهمة لك.</h1><p>الكلمات المفضلة تبقى محفوظة على جهازك ويمكنك تصفيتها بالبحث أو فتح مستواها مباشرة.</p></div><div class="intro-stat favorite-stat"><strong>${records.length.toLocaleString('ar-JO')}</strong><span>كلمة مفضلة</span></div></div>
    <div class="word-tools"><div class="search-wrap"><span>⌕</span><input id="favoriteSearch" type="search" placeholder="ابحث في المفضلة بالإنجليزية أو العربية…" autocomplete="off"></div></div>
    <div id="favoritesResults">${records.length ? `<div class="word-grid">${records.slice(0,90).map(renderWordCard).join('')}</div>` : `<div class="empty-state"><div class="empty-icon">♡</div><h3>لم تضف كلمات بعد</h3><p>اضغط رمز القلب على أي بطاقة كلمة لإضافتها هنا.</p><button class="button button-primary" data-section="learn">تصفّح الكلمات</button></div>`}</div>`;
}

function renderStats() {
  const stats = totalStats();
  const bars = LEVELS.map(level => {
    const open = app.meta.unlockedLevels.includes(level);
    const summary = getLevelProgressSummary(level);
    return `<div class="stats-level-row"><div class="stats-level-name"><span class="level-mini ${LEVEL_COLORS[level]}">${level}</span><div><strong>${LEVEL_NAMES[level]}</strong><small>${open ? `${summary.mastered} من ${summary.total} متقنة` : 'لم يُفتح بعد'}</small></div></div><div class="stats-level-bar"><span style="width:${open ? summary.percent : 0}%"></span></div><b>${open ? `${summary.percent}%` : '🔒'}</b></div>`;
  }).join('');
  const allHistory = app.history.slice(0, 8);
  ui.view.innerHTML = `<div class="page-intro"><div><span class="section-kicker">تقدّم قابل للقياس</span><h1>التعلّم يظهر في أرقامك.</h1><p>الإحصائيات محسوبة من سجلك المحفوظ على هذا الجهاز، ويمكنك تصدير نسخة احتياطية في أي وقت.</p></div><div class="intro-stat"><strong>${stats.percent}%</strong><span>إتقان المستويات المفتوحة</span></div></div>
    <div class="stats-overview-grid"><article class="stats-big-card"><span class="section-kicker">إجمالي الإتقان</span><strong>${stats.mastered.toLocaleString('ar-JO')}</strong><small>كلمة متقنة من أصل ${stats.total.toLocaleString('ar-JO')} في المستويات المفتوحة</small><div class="wide-progress"><span style="width:${stats.percent}%"></span></div></article><article class="stats-side-card"><span class="stat-icon icon-amber">↻</span><strong>${stats.review.toLocaleString('ar-JO')}</strong><small>كلمات تنتظر المراجعة</small></article><article class="stats-side-card"><span class="stat-icon icon-indigo">✦</span><strong>${app.history.length.toLocaleString('ar-JO')}</strong><small>اختبارات محفوظة</small></article></div>
    <div class="panel-card stats-level-panel"><div class="panel-heading"><div><span class="section-kicker">التقدم حسب المستوى</span><h2>أين وصلت؟</h2></div></div>${bars}</div>
    <div class="section-heading section-heading-spaced"><div><span class="section-kicker">سجل النشاط</span><h2>آخر الاختبارات</h2></div></div>${allHistory.length ? `<div class="history-list">${allHistory.map(historyItemHTML).join('')}</div>` : `<div class="empty-state compact-empty"><p>سيظهر سجل نتائجك هنا بعد أول اختبار.</p></div>`}`;
}

function renderSettings() {
  const meaningCount = app.words.filter(word => word.meanings.length).length;
  const examplesCount = app.words.filter(word => word.exampleEnglish && word.exampleArabic).length;
  ui.view.innerHTML = `<div class="page-intro"><div><span class="section-kicker">التحكم والخصوصية</span><h1>بياناتك، إعداداتك، وعلى جهازك.</h1><p>التقدم والمفضلة والأخطاء والاختبارات تُحفظ محليًا باستخدام IndexedDB. لا يوجد حساب ولا إرسال لبياناتك إلى خادم.</p></div><div class="privacy-stamp">◈ <span>محلي أولًا</span></div></div>
    <div class="settings-grid"><article class="panel-card settings-card"><span class="settings-icon">☼</span><div><h3>المظهر</h3><p>اختر المظهر الفاتح أو الداكن. يتم حفظ اختيارك على الجهاز.</p><div class="theme-choices"><button class="theme-choice ${document.body.dataset.theme !== 'dark' ? 'selected' : ''}" data-action="set-theme" data-theme="light">☀ فاتح</button><button class="theme-choice ${document.body.dataset.theme === 'dark' ? 'selected' : ''}" data-action="set-theme" data-theme="dark">☾ داكن</button></div></div></article>
      <article class="panel-card settings-card"><span class="settings-icon">⇩</span><div><h3>نسخة احتياطية</h3><p>صدّر تقدمك والمفضلة والأخطاء والمستويات المفتوحة وسجل الاختبارات إلى ملف JSON.</p><button class="button button-primary" data-action="export-backup">تصدير نسخة احتياطية</button></div></article>
      <article class="panel-card settings-card"><span class="settings-icon">⇧</span><div><h3>استعادة البيانات</h3><p>استورد ملفًا سابقًا من LEXORA. سيتم استبدال بيانات التقدم الحالية بعد التحقق من الملف.</p><button class="button button-soft" data-action="import-backup">اختيار ملف للاستيراد</button></div></article>
      <article class="panel-card settings-card"><span class="settings-icon">▣</span><div><h3>تثبيت التطبيق</h3><p>يحتاج التثبيت إلى HTTPS أو localhost. فتح ملف HTML مباشرة لا يفعّل PWA أو التخزين غير المتصل.</p><button class="button button-soft" data-action="install-help">عرض طريقة التثبيت</button></div></article>
    </div>
    <div class="panel-card data-audit-card"><div class="panel-heading"><div><span class="section-kicker">معلومات قاعدة الكلمات</span><h2>مصدر البيانات</h2></div><span class="soft-chip">Oxford · American English</span></div><div class="audit-stats"><div><strong>${app.words.length.toLocaleString('ar-JO')}</strong><small>مدخل معنى/تصنيف</small></div><div><strong>3,000</strong><small>مفردة فريدة حسب الاستخراج</small></div><div><strong>${meaningCount.toLocaleString('ar-JO')}</strong><small>مدخل له ترجمة مبدئية</small></div><div><strong>${(app.words.length - meaningCount).toLocaleString('ar-JO')}</strong><small>مدخل يحتاج ترجمة</small></div></div><p class="audit-warning">تنبيه جودة: الترجمات المبدئية الموروثة من الموقع السابق لم تُراجع لغويًا بشكل مستقل، والأمثلة غير متوفرة في المصدرين. لا نعرض معنى أو مثالًا مختلقًا على أنه موثوق.</p>
      <div class="source-links"><span>المصدر الأساسي: ملف Oxford 3000 المرفق (11 صفحة)</span><span>لا يتضمن هذا الإصدار مستوى C1.</span></div></div>
    <div class="danger-zone"><div><strong>إعادة ضبط بيانات التقدم</strong><small>هذا الإجراء يمسح تقدمك المحلي وسجل الاختبارات. صدّر نسخة احتياطية أولًا.</small></div><button class="button button-danger" data-action="reset-progress">مسح بيانات التقدم</button></div>`;
}

function randomChoices(correct, candidates, count = 4, selector = item => item) {
  const correctValue = selector(correct);
  const wrong = shuffle(candidates.filter(item => selector(item) !== correctValue))
    .map(selector).filter((value, index, list) => value && list.indexOf(value) === index && value !== correctValue)
    .slice(0, count - 1);
  return shuffle([correctValue, ...wrong]);
}

function maskWord(word) {
  const chars = [...word];
  const letters = chars.map((char, index) => /[A-Za-z]/.test(char) ? index : -1).filter(index => index >= 0);
  if (!letters.length) return word;
  // Prefer an interior letter for longer words; for one- or two-letter words
  // mask an actual letter rather than accidentally showing the full answer.
  const interior = letters.filter(index => index > 0 && index < chars.length - 1);
  const candidates = interior.length ? interior : letters;
  const index = candidates[Math.floor(Math.random() * candidates.length)];
  chars[index] = '_';
  return chars.join('');
}

function levelOptions(level) {
  return getLevelWords(level);
}

function availableTypes(word, level) {
  const types = ['missing', 'pos'];
  if (currentGloss(word, level)) types.push('meaning', 'word', 'matching');
  if (app.englishVoice) types.push('listen');
  const p = getProgress(word, level);
  if (p.exampleEnglish && p.exampleArabic) types.push('sentence');
  return types;
}

function createQuestion(word, level, pool, index) {
  const types = availableTypes(word, level);
  const type = types[index % types.length];
  const correctGloss = currentGloss(word, level);
  const displayWord = word.searchHeadword || word.headword;
  const glossedPool = pool.filter(item => currentGloss(item, level));
  const englishPool = pool.filter(item => (item.searchHeadword || item.headword) !== displayWord);
  const posPool = [...new Set(pool.map(item => currentPos(item, level)).filter(Boolean))];
  const correctPOS = currentPos(word, level);
  let question;
  if (type === 'meaning') {
    const options = randomChoices(correctGloss, glossedPool, 4, item => typeof item === 'string' ? item : currentGloss(item, level));
    question = { type, label: 'اختر المعنى العربي الصحيح', prompt: word.headword, answer: correctGloss, options };
  } else if (type === 'word' || type === 'matching') {
    const options = randomChoices(displayWord, englishPool, 4, item => typeof item === 'string' ? item : (item.searchHeadword || item.headword));
    question = { type, label: type === 'matching' ? 'طابق المعنى مع الكلمة' : 'اختر الكلمة الإنجليزية الصحيحة', prompt: correctGloss, answer: displayWord, options };
  } else if (type === 'listen') {
    const options = randomChoices(displayWord, englishPool, 4, item => typeof item === 'string' ? item : (item.searchHeadword || item.headword));
    question = { type, label: 'استمع واختر الكلمة التي سمعتها', prompt: 'اضغط زر الاستماع ثم اختر الإجابة', answer: displayWord, options, voiceText: displayWord };
  } else if (type === 'sentence') {
    const progress = getProgress(word, level);
    const sentence = progress.exampleEnglish || word.exampleEnglish;
    const pattern = new RegExp(word.searchHeadword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const prompt = sentence.replace(pattern, '________');
    const options = randomChoices(displayWord, englishPool, 4, item => typeof item === 'string' ? item : (item.searchHeadword || item.headword));
    question = { type, label: 'اختر الكلمة المناسبة في الجملة', prompt, answer: displayWord, options, explanation: progress.exampleArabic || word.exampleArabic };
  } else if (type === 'pos') {
    const options = randomChoices(correctPOS, posPool, 4, item => item);
    question = { type, label: 'ما نوع الكلمة حسب تصنيف المصدر؟', prompt: word.headword, answer: correctPOS, options };
  } else {
    question = { type: 'missing', label: 'أكمل الكلمة الناقصة', prompt: maskWord(displayWord), answer: displayWord, options: [] };
  }
  return { id: `${word.id}-${type}`, wordId: word.id, level, word, ...question, answered: false, isCorrect: null };
}

function takeFinalBatch(level, count) {
  const pool = getLevelWords(level);
  const allIds = pool.map(word => word.id);
  let coverage = app.meta.coverage[level];
  const valid = coverage && Array.isArray(coverage.orderedIds) && coverage.orderedIds.length === allIds.length && coverage.orderedIds.every(id => allIds.includes(id));
  if (!valid) coverage = { orderedIds: shuffle(allIds), cursor: 0, cycles: 0 };
  if (coverage.cursor >= coverage.orderedIds.length) {
    coverage = { orderedIds: shuffle(allIds), cursor: 0, cycles: (coverage.cycles || 0) + 1 };
  }
  const selectedIds = coverage.orderedIds.slice(coverage.cursor, coverage.cursor + Math.min(count, pool.length));
  coverage.cursor += selectedIds.length;
  app.meta.coverage[level] = coverage;
  const map = new Map(pool.map(word => [word.id, word]));
  return selectedIds.map(id => map.get(id)).filter(Boolean);
}

function startQuiz(kind) {
  const levelSelect = document.getElementById('quizLevel');
  const countSelect = document.getElementById('quizCount');
  const level = levelSelect?.value || app.level;
  const count = Number(countSelect?.value || DEFAULT_QUESTION_COUNT);
  if (!app.meta.unlockedLevels.includes(level)) return showToast('هذا المستوى لم يُفتح بعد.', 'warning');
  let pool = levelOptions(level);
  const coverageBefore = app.meta.coverage[level] ? JSON.parse(JSON.stringify(app.meta.coverage[level])) : null;
  let chosen;
  if (kind === 'errors') {
    pool = collectFlaggedRecords(p => (p.needsReview || p.status === 'review' || (p.nextReviewAt && new Date(p.nextReviewAt) <= new Date())) && p.level === level).map(item => item.word);
    if (!pool.length) return showToast('لا توجد كلمات خاطئة تحتاج إلى اختبار.', 'info');
    chosen = shuffle(pool).slice(0, count);
  } else if (kind === 'final') {
    chosen = takeFinalBatch(level, count);
  } else {
    chosen = shuffle(pool).slice(0, count);
  }
  // The pool is sampled without replacement, so each dictionary entry is used at most once in this test.
  const questions = chosen.map((word, index) => createQuestion(word, level, pool, index));
  app.level = level;
  app.activeQuiz = {
    id: crypto.randomUUID ? crypto.randomUUID() : `quiz-${Date.now()}`,
    kind, level, questions, index: 0, correct: 0, wrong: 0, coverageBefore,
    startedAt: new Date().toISOString(), finished: false
  };
  app.section = 'quiz';
  renderQuizQuestion();
  renderNav();
}

function renderQuizQuestion() {
  const quiz = app.activeQuiz;
  if (!quiz) return renderQuizLanding();
  const q = quiz.questions[quiz.index];
  const total = quiz.questions.length;
  const answered = q.answered;
  const pct = Math.round(((quiz.index + (answered ? 1 : 0)) / total) * 100);
  const kindLabel = quiz.kind === 'final' ? 'اختبار نهائي' : quiz.kind === 'errors' ? 'مراجعة الأخطاء' : 'تدريب';
  const content = q.type === 'missing'
    ? `<form id="fillAnswerForm" class="fill-answer-form"><input id="fillAnswer" type="text" dir="ltr" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="اكتب الكلمة كاملة" ${answered ? 'disabled' : 'required'}><button class="button button-primary" type="submit" ${answered ? 'disabled' : ''}>تحقق من الإجابة</button></form>`
    : `<div class="quiz-options-grid">${q.options.map((option, i) => `<button class="quiz-option ${answered && option === q.answer ? 'option-correct' : ''} ${answered && option === q.selected && !q.isCorrect ? 'option-wrong' : ''}" data-action="quiz-answer" data-option="${escapeHTML(option)}" ${answered ? 'disabled' : ''}><span class="option-letter">${['أ','ب','ج','د'][i] || '•'}</span><span>${escapeHTML(option)}</span></button>`).join('')}</div>`;
  ui.view.innerHTML = `<div class="quiz-live-top"><button class="back-link" data-action="quit-quiz">← إنهاء الجلسة</button><span class="quiz-mode-badge">${kindLabel} · ${quiz.level}</span></div>
    <div class="quiz-session-card"><div class="quiz-session-head"><div><span class="section-kicker">السؤال ${(quiz.index+1).toLocaleString('ar-JO')} من ${total.toLocaleString('ar-JO')}</span><h1>${escapeHTML(q.label)}</h1></div><div class="quiz-countdown">${(quiz.index+1).toString().padStart(2,'0')}<small>/ ${total.toString().padStart(2,'0')}</small></div></div>
      <div class="quiz-progress-track"><span style="width:${pct}%"></span></div>
      <div class="quiz-prompt-wrap"><div class="quiz-prompt-label">${q.type === 'listen' ? 'استمع أولًا' : q.type === 'missing' ? 'الكلمة الناقصة' : 'السؤال'}</div><div class="quiz-prompt ${['meaning','pos'].includes(q.type) ? '' : 'prompt-ltr'}" ${['meaning','pos'].includes(q.type) ? '' : 'dir="ltr"'}>${escapeHTML(q.prompt)}</div>
        ${q.type === 'listen' ? `<button class="listen-question-button" data-action="play-question">◖ استمع مرة أخرى</button>` : ''}
        ${content}
      </div>
      ${answered ? `<div class="answer-feedback ${q.isCorrect ? 'feedback-good' : 'feedback-bad'}"><div class="feedback-icon">${q.isCorrect ? '✓' : '!'}</div><div><strong>${q.isCorrect ? 'إجابة صحيحة!' : 'ليست الإجابة الصحيحة'}</strong><p>${q.isCorrect ? 'أحسنت. واصل بنفس التركيز.' : `الإجابة الصحيحة: ${escapeHTML(q.answer)}`}${q.explanation ? `<br>${escapeHTML(q.explanation)}` : ''}</p></div></div><button class="button button-primary quiz-next-button" data-action="quiz-next">${quiz.index === total-1 ? 'عرض النتيجة' : 'السؤال التالي ←'}</button>` : `<div class="quiz-hint">لن تظهر الإجابة الصحيحة قبل أن تختار إجابتك أو تتحقق منها.</div>`}
      <div class="quiz-session-footer"><span>✓ ${quiz.correct.toLocaleString('ar-JO')} صحيحة</span><span>× ${quiz.wrong.toLocaleString('ar-JO')} خاطئة</span><span>${quiz.level} · LEXORA</span></div>
    </div>`;
  if (q.type === 'listen' && !answered) playLocalSpeech(q.voiceText, 'en-US', true);
  if (q.type === 'missing' && !answered) document.getElementById('fillAnswer')?.focus();
}

function normalizeAnswer(value) {
  return String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

async function submitAnswer(value) {
  const quiz = app.activeQuiz;
  if (!quiz || quiz.finished) return;
  const q = quiz.questions[quiz.index];
  if (q.answered) return;
  const selected = String(value ?? '').trim();
  q.selected = selected;
  q.answered = true;
  q.isCorrect = normalizeAnswer(selected) === normalizeAnswer(q.answer);
  if (q.isCorrect) quiz.correct += 1;
  else quiz.wrong += 1;
  await recordWordAttempt(q.word, q.level, q.isCorrect, quiz.kind);
  renderQuizQuestion();
}

async function recordWordAttempt(word, level, correct, quizKind) {
  const p = getProgress(word, level);
  const now = new Date();
  p.attempts = (p.attempts || 0) + 1;
  p.lastSeenAt = now.toISOString();
  if (!correct) {
    p.wrongCount = (p.wrongCount || 0) + 1;
    p.status = 'review';
    p.needsReview = true;
    p.correctStreak = 0;
    p.reviewCorrectStreak = 0;
    p.nextReviewAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  } else {
    p.correctCount = (p.correctCount || 0) + 1;
    p.correctStreak = (p.correctStreak || 0) + 1;
    if (p.needsReview || p.status === 'review') {
      if (quizKind === 'errors') p.reviewCorrectStreak = (p.reviewCorrectStreak || 0) + 1;
      if (p.reviewCorrectStreak >= 3) {
        p.needsReview = false;
        p.status = 'mastered';
        p.wrongCount = 0;
        p.reviewCorrectStreak = 0;
      }
    } else if (p.correctStreak >= 3) {
      p.status = 'mastered';
    }
    const stage = Math.min(Math.max((p.successfulReviews || 0), 0), REVIEW_INTERVAL_DAYS.length - 1);
    const days = REVIEW_INTERVAL_DAYS[stage];
    p.successfulReviews = (p.successfulReviews || 0) + 1;
    p.nextReviewAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  }
  await saveProgress(p);
}

async function finishQuiz() {
  const quiz = app.activeQuiz;
  if (!quiz || quiz.finished) return;
  quiz.finished = true;
  const total = quiz.questions.length;
  const pct = scorePercentage(quiz.correct, total);
  let unlocked = null;
  const next = nextLevel(quiz.level);
  if (quiz.kind === 'final') {
    const previousLevels = [...app.meta.unlockedLevels];
    const updatedLevels = unlockedLevelsAfterFinal(pct, quiz.level, previousLevels);
    unlocked = updatedLevels.find(level => !previousLevels.includes(level)) || null;
    app.meta.unlockedLevels = updatedLevels;
    if (unlocked) await saveMeta(app.db, app.meta);
  }
  await saveMeta(app.db, app.meta);
  const historyRecord = {
    id: quiz.id,
    date: new Date().toISOString(),
    level: quiz.level,
    kind: quiz.kind,
    total,
    correct: quiz.correct,
    wrong: quiz.wrong,
    scorePercentage: pct,
    questionWordIds: quiz.questions.map(q => q.wordId),
    durationSeconds: Math.max(0, Math.round((Date.now() - new Date(quiz.startedAt).getTime()) / 1000))
  };
  await saveQuizResult(app.db, historyRecord);
  app.history.unshift(historyRecord);
  renderQuizResult(pct, total, unlocked, next);
}

function renderQuizResult(pct, total, unlocked, next) {
  const quiz = app.activeQuiz;
  const passed = qualifiesToUnlock(pct);
  const isFinal = quiz.kind === 'final';
  let message = 'تم حفظ نتيجتك. راجع الإجابات التي أخطأت فيها، ثم جرّب مرة أخرى.';
  if (isFinal && passed && unlocked) message = `رائع! حققت ${pct}%، وتم فتح المستوى ${unlocked} تلقائيًا.`;
  else if (isFinal && passed && !unlocked && next && app.meta.unlockedLevels.includes(next)) message = `اجتزت الاختبار بنسبة ${pct}%. المستوى ${next} مفتوح لديك بالفعل وسيبقى مفتوحًا.`;
  else if (isFinal && passed && !next) message = `اجتزت المستوى الأخير في نطاق هذا المصدر. لا يتضمن ملف Oxford المرفق مستوى C1.`;
  else if (isFinal && !passed) message = `تحتاج إلى 90% على الأقل لفتح المستوى التالي. نتيجتك الحالية ${pct}%. يمكنك إعادة الاختبار في أي وقت.`;
  const statusClass = isFinal && passed ? 'result-pass' : 'result-continue';
  ui.view.innerHTML = `<div class="quiz-result-card"><div class="result-orbit ${statusClass}"><div class="result-ring"><strong>${pct}%</strong><small>نتيجتك</small></div></div><span class="section-kicker">${isFinal ? 'نتيجة الاختبار النهائي' : 'انتهت الجلسة'}</span><h1>${isFinal && passed ? 'اجتزت التحدي!' : isFinal ? 'واصل التدرّب' : 'أحسنت إكمال الاختبار'}</h1><p class="result-message">${escapeHTML(message)}</p>
      <div class="result-breakdown"><div><strong>${quiz.correct.toLocaleString('ar-JO')}</strong><small>إجابات صحيحة</small></div><div><strong>${quiz.wrong.toLocaleString('ar-JO')}</strong><small>إجابات خاطئة</small></div><div><strong>${total.toLocaleString('ar-JO')}</strong><small>إجمالي الأسئلة</small></div></div>
      ${isFinal && unlocked ? `<button class="button button-primary result-main-action" data-action="open-level" data-level="${unlocked}">انتقل إلى ${unlocked} ←</button>` : `<button class="button button-primary result-main-action" data-action="start-again" data-kind="${quiz.kind}" data-level="${quiz.level}">إعادة الاختبار</button>`}
      <button class="button button-soft" data-action="show-results-history">عرض سجل الاختبارات</button><div class="result-footnote">تم حفظ هذه النتيجة على جهازك.</div></div>`;
  updateSidebar();
}

function openWordEditor(wordId, level) {
  const word = byId(wordId);
  if (!word) return;
  const p = getProgress(word, level);
  const gloss = currentGloss(word, level);
  const exampleEn = p.exampleEnglish || word.exampleEnglish || '';
  const exampleAr = p.exampleArabic || word.exampleArabic || '';
  ui.modal.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="wordEditTitle"><button class="modal-close" data-action="close-modal" aria-label="إغلاق">×</button><span class="section-kicker">إثراء قاموسك</span><h2 id="wordEditTitle" lang="en" dir="ltr">${escapeHTML(word.headword)}</h2><p class="modal-subtitle">${level} · ${escapeHTML(currentPos(word, level))}</p>
    <form id="wordEditForm" data-word-id="${wordId}" data-level="${level}"><label for="editMeaning">المعنى أو المعاني العربية</label><textarea id="editMeaning" name="meaning" rows="3" placeholder="اكتب المعنى بدقة، وافصل المعاني المتعددة بفاصلة منقوطة">${escapeHTML(gloss)}</textarea><label for="editExampleEn">مثال باللغة الإنجليزية</label><textarea id="editExampleEn" name="exampleEnglish" rows="2" dir="ltr" placeholder="Write a natural example sentence.">${escapeHTML(exampleEn)}</textarea><label for="editExampleAr">ترجمة المثال</label><textarea id="editExampleAr" name="exampleArabic" rows="2" placeholder="ترجمة المثال إلى العربية">${escapeHTML(exampleAr)}</textarea><div class="modal-actions"><button type="button" class="button button-soft" data-action="close-modal">إلغاء</button><button type="submit" class="button button-primary">حفظ التعديل</button></div></form><small class="modal-note">ما تضيفه هنا يُحفظ محليًا كتعديل شخصي، ولا يغيّر تصنيف Oxford الأصلي.</small></section></div>`;
}

function closeModal() { ui.modal.innerHTML = ''; }

function updateVoiceList() {
  if (!('speechSynthesis' in window)) {
    app.voices = []; app.englishVoice = null; app.arabicVoice = null;
    updateVoiceButtons(); return;
  }
  app.voices = window.speechSynthesis.getVoices() || [];
  app.englishVoice = app.voices.find(voice => voice.localService && /^en(-|$)/i.test(voice.lang)) || null;
  app.arabicVoice = app.voices.find(voice => voice.localService && /^ar(-|$)/i.test(voice.lang)) || null;
  updateVoiceButtons();
}

function updateVoiceButtons() {
  document.querySelectorAll('.speak-en').forEach(button => {
    button.hidden = !app.englishVoice;
    button.title = app.englishVoice ? `صوت محلي: ${app.englishVoice.name}` : 'لا يتوفر صوت إنجليزي محلي في هذا المتصفح';
  });
  document.querySelectorAll('.speak-ar').forEach(button => {
    const word = byId(button.dataset.wordId);
    const hasText = word && currentGloss(word, button.dataset.level || app.level).trim();
    button.hidden = !app.arabicVoice || !hasText;
    button.title = !app.arabicVoice ? 'لا يتوفر صوت عربي محلي في هذا المتصفح' : hasText ? `صوت عربي محلي: ${app.arabicVoice.name}` : 'أضف المعنى العربي أولًا';
  });
}

function playLocalSpeech(text, language, quiet = false) {
  const voice = /^ar/i.test(language) ? app.arabicVoice : app.englishVoice;
  if (!voice || !('speechSynthesis' in window)) {
    if (!quiet) showToast('لا يوجد صوت محلي متاح لهذه اللغة على هذا الجهاز. لم يتم الاتصال بخدمة صوتية خارجية.', 'warning');
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.rate = 0.88;
  window.speechSynthesis.speak(utterance);
}

function setTheme(theme) {
  document.body.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  localStorage.setItem('lexora-theme', document.body.dataset.theme);
  const toggle = document.getElementById('themeToggle');
  if (toggle) toggle.textContent = document.body.dataset.theme === 'dark' ? '☾' : '☼';
  render();
}

function exportBackup() {
  const words = [...app.progress.values()];
  const backup = {
    app: 'LEXORA Oxford 3000',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    wordProgress: words,
    meta: app.meta,
    quizHistory: app.history
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `lexora-backup-${new Date().toISOString().slice(0,10)}.json`;
  document.body.append(anchor); anchor.click(); anchor.remove();
  URL.revokeObjectURL(url);
  showToast('تم تجهيز ملف النسخة الاحتياطية.', 'success');
}

async function importBackup(file) {
  try {
    const backup = JSON.parse(await file.text());
    await replaceUserData(app.db, backup);
    const snapshot = await loadUserData(app.db);
    app.progress = new Map(snapshot.wordProgress.map(item => [item.id, item]));
    app.meta = snapshot.meta;
    app.history = snapshot.quizHistory;
    app.activeQuiz = null;
    closeModal();
    setSection('home');
    showToast('تم استيراد بيانات النسخة الاحتياطية بنجاح.', 'success');
  } catch (error) {
    showToast(error.message || 'تعذّر استيراد الملف.', 'error');
  }
}

function showInstallHelp() {
  ui.modal.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal-card install-help-card" role="dialog" aria-modal="true"><button class="modal-close" data-action="close-modal">×</button><span class="section-kicker">تثبيت LEXORA</span><h2>أضف المنصة إلى جهازك</h2><div class="install-step"><b>1</b><p>شغّل المشروع عبر HTTPS أو localhost. لا يعمل تثبيت PWA من ملف HTML المفتوح مباشرة.</p></div><div class="install-step"><b>2</b><p><strong>Android:</strong> افتح رابط الموقع في Chrome ثم اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية» من قائمة المتصفح.</p></div><div class="install-step"><b>3</b><p><strong>Windows / Desktop:</strong> افتح الموقع في متصفح يدعم PWA، ثم اختر أيقونة التثبيت في شريط العنوان أو زر التثبيت داخل المنصة.</p></div><div class="install-step"><b>4</b><p>افتح المنصة مرة وهي متصلة حتى تُحمّل ملفات التطبيق وقاعدة الكلمات، ثم جرّب وضع الطيران للتأكد من العمل دون اتصال.</p></div><button class="button button-primary full-width" data-action="close-modal">حسنًا</button></section></div>`;
}

function installApp() {
  if (!app.installPrompt) {
    showInstallHelp();
    return;
  }
  app.installPrompt.prompt();
  app.installPrompt.userChoice.then(choice => {
    if (choice?.outcome === 'accepted') showToast('بدأ تثبيت LEXORA.', 'success');
    app.installPrompt = null;
    ui.install.hidden = true;
  }).catch(() => showInstallHelp());
}

async function resetProgress() {
  const accepted = window.confirm('هل تريد مسح كل تقدمك وسجل الاختبارات والمفضلة؟ لا يمكن التراجع عن هذا الإجراء.');
  if (!accepted) return;
  try {
    const tx = app.db.transaction(['wordProgress','appMeta','quizHistory'], 'readwrite');
    tx.objectStore('wordProgress').clear();
    tx.objectStore('quizHistory').clear();
    app.meta = { id:'main', unlockedLevels:['A1'], coverage:{}, lastVisited:{section:'home',level:'A1',wordId:null}, createdAt:new Date().toISOString() };
    tx.objectStore('appMeta').put(app.meta);
    await new Promise((resolve,reject) => { tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error); });
    app.progress.clear(); app.history=[]; app.activeQuiz=null; app.level='A1';
    setSection('home'); showToast('تمت إعادة ضبط التقدم. قاعدة كلمات Oxford لم تتغير.', 'success');
  } catch (error) { showToast('تعذّرت إعادة ضبط البيانات.', 'error'); }
}

function showMobileMenu() {
  document.getElementById('sidebar').classList.toggle('sidebar-open');
}

function handleClick(event) {
  const sectionButton = event.target.closest('[data-section]');
  if (sectionButton) {
    setSection(sectionButton.dataset.section);
    document.getElementById('sidebar').classList.remove('sidebar-open');
    return;
  }
  const filterButton = event.target.closest('[data-filter]');
  if (filterButton && app.section === 'learn') {
    app.filter = filterButton.dataset.filter;
    app.wordPage = 0;
    renderLearn(); updateVoiceButtons();
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, wordId, level = app.level } = button.dataset;
  if (action === 'open-level') return openLevel(button.dataset.level);
  if (action === 'clear-filters') { app.filter='all'; app.search=''; renderLearn(); return; }
  if (action === 'word-page') { app.wordPage += Number(button.dataset.delta); renderLearn(); updateVoiceButtons(); return; }
  if (action === 'favorite' || action === 'toggle-mastered' || action === 'mark-review') {
    const word = byId(wordId); if (!word) return;
    const p = getProgress(word, level);
    if (action === 'favorite') p.favorite = !p.favorite;
    if (action === 'toggle-mastered') {
      p.status = p.status === 'mastered' ? 'new' : 'mastered';
      p.needsReview = false;
      if (p.status === 'mastered') { p.wrongCount = 0; p.reviewCorrectStreak = 0; }
    }
    if (action === 'mark-review') { p.status='review'; p.needsReview=true; p.reviewCorrectStreak=0; p.nextReviewAt=new Date().toISOString(); }
    saveProgress(p).then(() => { render(); showToast(action==='favorite' ? (p.favorite ? 'أضيفت إلى المفضلة.' : 'أزيلت من المفضلة.') : 'تم تحديث حالة الكلمة.', 'success'); });
    return;
  }
  if (action === 'speak-en' || action === 'speak-ar') {
    const word=byId(wordId); if (!word) return;
    playLocalSpeech(action === 'speak-en' ? (word.searchHeadword || word.headword) : currentGloss(word,level), action === 'speak-en' ? 'en-US' : 'ar');
    return;
  }
  if (action === 'edit-word') return openWordEditor(wordId, level);
  if (action === 'start-quiz') return startQuiz(button.dataset.kind);
  if (action === 'quiz-answer') return submitAnswer(button.dataset.option);
  if (action === 'quiz-next') {
    const quiz=app.activeQuiz; if (!quiz) return;
    if (quiz.index >= quiz.questions.length - 1) return finishQuiz();
    quiz.index += 1; renderQuizQuestion(); return;
  }
  if (action === 'play-question') {
    const q=app.activeQuiz?.questions[app.activeQuiz.index]; if(q) playLocalSpeech(q.voiceText,'en-US'); return;
  }
  if (action === 'quit-quiz') {
    if (window.confirm('هل تريد إنهاء الاختبار دون حفظ نتيجة نهائية؟')) {
      if (app.activeQuiz?.kind === 'final') {
        if (app.activeQuiz.coverageBefore) app.meta.coverage[app.activeQuiz.level] = app.activeQuiz.coverageBefore;
        else delete app.meta.coverage[app.activeQuiz.level];
        saveMeta(app.db, app.meta).catch(() => {});
      }
      app.activeQuiz=null; setSection('quiz');
    }
    return;
  }
  if (action === 'start-again') { app.level=button.dataset.level; return startQuiz(button.dataset.kind); }
  if (action === 'show-results-history') return setSection('stats');
  if (action === 'export-backup') return exportBackup();
  if (action === 'import-backup') { ui.backupFile.click(); return; }
  if (action === 'install-help') return showInstallHelp();
  if (action === 'close-modal') { closeModal(); return; }
  if (action === 'set-theme') { setTheme(button.dataset.theme); return; }
  if (action === 'reset-progress') return resetProgress();
}

function handleSubmit(event) {
  if (event.target.id === 'fillAnswerForm') {
    event.preventDefault();
    const input = document.getElementById('fillAnswer');
    submitAnswer(input?.value || '');
    return;
  }
  if (event.target.id === 'wordEditForm') {
    event.preventDefault();
    const form = event.target;
    const word = byId(form.dataset.wordId); if (!word) return;
    const p = getProgress(word, form.dataset.level);
    p.translationOverride = form.elements.meaning.value.trim();
    p.exampleEnglish = form.elements.exampleEnglish.value.trim();
    p.exampleArabic = form.elements.exampleArabic.value.trim();
    saveProgress(p).then(() => {
      closeModal(); render();
      showToast('تم حفظ المعنى والمثال على جهازك.', 'success');
    });
  }
}

function handleInput(event) {
  if (event.target.id === 'wordSearch') {
    app.search = event.target.value;
    app.wordPage = 0;
    renderLearn(); updateVoiceButtons();
    const input = document.getElementById('wordSearch');
    input?.focus();
    input?.setSelectionRange(app.search.length, app.search.length);
  }
  if (event.target.id === 'favoriteSearch') {
    const search = event.target.value.toLocaleLowerCase();
    const records = collectFlaggedRecords(p=>p.favorite).filter(({word,level}) => [word.headword,word.searchHeadword,currentGloss(word,level)].some(x=>String(x).toLocaleLowerCase().includes(search)));
    const root=document.getElementById('favoritesResults');
    if(root) root.innerHTML=records.length ? `<div class="word-grid">${records.slice(0,90).map(renderWordCard).join('')}</div>` : `<div class="empty-state compact-empty"><p>لا توجد نتائج مطابقة.</p></div>`;
    updateVoiceButtons();
  }
}

function handleChange(event) {
  if (event.target.id === 'learnLevel') openLevel(event.target.value);
  if (event.target.id === 'backupFile') {
    const file = event.target.files?.[0];
    if (file) importBackup(file);
    event.target.value = '';
  }
}

function handleKeydown(event) {
  if (event.key === 'Escape') closeModal();
}

function updateConnectionStatus() {
  const online = navigator.onLine;
  ui.connection.classList.toggle('is-online', online);
  ui.connection.querySelector('b').textContent = online ? 'متصل' : 'دون إنترنت';
}

async function init() {
  try {
    const [db, response] = await Promise.all([openDatabase(), fetch(DATA_URL)]);
    if (!response.ok) throw new Error('تعذر تحميل قاعدة الكلمات.');
    const dataset = await response.json();
    if (!Array.isArray(dataset.words) || dataset.words.length === 0) {
      document.body.classList.add('dataset-missing');
      ui.view.innerHTML = `<div class="setup-required"><div class="setup-mark">LEXORA</div><span class="section-kicker">خطوة الإعداد الأولى</span><h1>قاعدة الكلمات لم تُضف بعد.</h1><p>أضف ملف بيانات JSON منظّمًا تملك حق استخدامه إلى المسار <b>data/oxford3000.json</b> وفق مخطط البيانات المرفق. لا تتضمن هذه الحزمة نسخة من قائمة Oxford المحمية، ولا تستخدم كلمات تجريبية بدلًا منها.</p><div class="setup-command">python scripts/validate_database.py --file data/oxford3000.json</div><p class="setup-small">بعد نجاح التحقق من الملف، أعد تحميل الصفحة. ستُحمّل المنصة بيانات الكلمات محليًا، ثم تحفظ التقدم وتتيح العمل دون اتصال بعد تثبيت موارد PWA.</p></div>`;
      return;
    }
    app.db = db;
    app.words = dataset.words || [];
    const snapshot = await loadUserData(db);
    app.progress = new Map(snapshot.wordProgress.map(item => [item.id, item]));
    app.meta = snapshot.meta;
    app.history = snapshot.quizHistory;
    app.persistenceReady = true;
    if (!app.meta.unlockedLevels?.length) app.meta.unlockedLevels = ['A1'];
    const saved = app.meta.lastVisited;
    if (saved?.level && app.meta.unlockedLevels.includes(saved.level)) app.level = saved.level;
    if (saved?.section && sectionTitles[saved.section]) app.section = saved.section;
    render();
    updateSidebar();
    registerServiceWorker();
    updateVoiceList();
    if ('speechSynthesis' in window) window.speechSynthesis.onvoiceschanged = updateVoiceList;
    window.addEventListener('online', updateConnectionStatus);
    window.addEventListener('offline', updateConnectionStatus);
    updateConnectionStatus();
  } catch (error) {
    ui.view.innerHTML = `<div class="fatal-error"><div class="empty-icon">!</div><h2>تعذّر تشغيل المنصة</h2><p>${escapeHTML(error.message)}<br>شغّل المشروع عبر خادم محلي أو HTTPS بدل فتح index.html مباشرة.</p></div>`;
  }
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showToast('تحديث جديد جاهز. أعد فتح المنصة لتطبيقه.', 'info');
      });
    });
  } catch (error) {
    console.warn('Service Worker registration failed:', error);
  }
}

function bindEvents() {
  document.addEventListener('click', handleClick);
  document.addEventListener('submit', handleSubmit);
  document.addEventListener('input', handleInput);
  document.addEventListener('change', handleChange);
  document.addEventListener('keydown', handleKeydown);
  document.getElementById('themeToggle').addEventListener('click', () => setTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark'));
  document.getElementById('mobileMenu').addEventListener('click', showMobileMenu);
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); app.installPrompt = event; ui.install.hidden = false;
  });
  window.addEventListener('appinstalled', () => { app.installPrompt = null; ui.install.hidden = true; showToast('تم تثبيت LEXORA بنجاح.', 'success'); });
  ui.install.addEventListener('click', installApp);
}

const savedTheme = localStorage.getItem('lexora-theme') || 'light';
document.body.dataset.theme = savedTheme;
document.getElementById('themeToggle').textContent = savedTheme === 'dark' ? '☾' : '☼';
bindEvents();
init();
