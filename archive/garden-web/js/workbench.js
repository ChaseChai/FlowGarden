// 镜园 FlowGarden · 专注模式工作台（设计指南 v2.0 §11）
// 花园退为情绪背景（blur 16px + 暗角），工作台浮为功能焦点
// 三栏：待办 | 聚焦计时器 | 日程时间线 + 底部 AI 流式对话条
// 动效遵循 motion-foundations：transform/opacity only、进出不对称、reduced-motion 降级

const gsap = window.gsap;
const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const TARGET_MIN = 45; // 默认专注目标 45 分钟

const fmt = s => {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

export class Workbench {
  constructor({ onExit, onPlantsToday } = {}) {
    this.open = false;
    this.focusSec = 0;
    this.onExit = onExit || (() => {});
    this.onPlantsToday = onPlantsToday || (() => 3);
    this.streamTimer = null;

    // 演示数据（展演剧本：论文日）
    this.todos = [
      { t: '完成第三章论文', done: true },
      { t: '复习数学第三章', done: false },
      { t: '回复导师邮件', done: false },
      { t: '整理本周笔记', done: false },
      { t: '跑步 30 分钟', done: false },
    ];
    this.schedule = [
      { time: '13:00', title: '午休', dur: 1 },
      { time: '14:00', title: '论文写作', dur: 2, current: true },
      { time: '16:00', title: '复习数学', dur: 1.5 },
      { time: '17:30', title: '回复邮件', dur: 0.5, tip: '镜灵建议挪到午休后' },
      { time: '19:00', title: '跑步', dur: 1 },
    ];

    this.$ = id => document.getElementById(id);
    this._bind();
    this._renderTodos();
    this._renderSchedule();
    this._tickClock();
  }

  _bind() {
    this.$('wb-exit').addEventListener('click', () => this.exit());
    this.$('tip-adopt').addEventListener('click', () => this._adoptTip());
    this.$('tip-ignore').addEventListener('click', () => {
      this.$('todo-tip').classList.add('dismissed');
    });
    this.$('todo-add').addEventListener('click', () => this._addTodo());
    this.$('chat-send').addEventListener('click', () => this._sendChat());
    this.$('chat-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') this._sendChat();
    });
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.open) this.exit();
    });
  }

  // ── 进入 / 退出（§11.2 过渡时间线）──────────────
  enter() {
    if (this.open) return;
    this.open = true;
    this.focusSec = 0;
    document.getElementById('app').classList.add('focusing');
    const wb = this.$('workbench');
    wb.classList.add('open');
    wb.setAttribute('aria-hidden', 'false');

    // 镜灵主动开场（AI 晨间规划口吻，§11.9）
    setTimeout(() => {
      this._stream('早安。今天有 4 件事：论文、复习、邮件和运动。\n你昨晚深睡只有 58 分钟——上午状态最好，我们先做论文吧。');
      this._renderChips(['把邮件挪到下午', '帮我拆分论文任务']);
    }, REDUCED ? 100 : 1200);
  }

  exit() {
    if (!this.open) return;
    this.open = false;
    document.getElementById('app').classList.remove('focusing');
    const wb = this.$('workbench');
    wb.classList.remove('open');
    wb.setAttribute('aria-hidden', 'true');
    this._stopStream();
    this.onExit(fmt(this.focusSec));
  }

  // ── 待办 ─────────────────────────────────────
  _renderTodos() {
    const ul = this.$('todo-list');
    ul.innerHTML = '';
    this.todos.forEach((todo, i) => {
      const li = document.createElement('li');
      li.className = 'todo-item' + (todo.done ? ' done' : '');
      li.innerHTML = `<span class="todo-check" aria-hidden="true"></span><span class="todo-text">${todo.t}</span>`;
      li.setAttribute('role', 'checkbox');
      li.setAttribute('aria-checked', String(todo.done));
      li.tabIndex = 0;
      const toggle = () => this._toggleTodo(i, li);
      li.addEventListener('click', toggle);
      li.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      ul.appendChild(li);
    });
    const done = this.todos.filter(t => t.done).length;
    this.$('todo-progress').textContent = `${done}/${this.todos.length}`;
  }

  _toggleTodo(i, li) {
    const todo = this.todos[i];
    todo.done = !todo.done;
    li.classList.toggle('done', todo.done);
    li.setAttribute('aria-checked', String(todo.done));
    if (todo.done) {
      this._goldBurst(li);
      this._stream(`「${todo.t}」完成了。很好，继续保持。`);
    }
    const done = this.todos.filter(t => t.done).length;
    this.$('todo-progress').textContent = `${done}/${this.todos.length}`;
  }

  _addTodo() {
    const input = this.$('chat-input');
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    this.todos.push({ t: text, done: false });
    input.value = '';
    this._renderTodos();
    const ul = this.$('todo-list');
    const li = ul.lastElementChild;
    if (li && !REDUCED) gsap.from(li, { y: -14, opacity: 0, duration: 0.35, ease: 'power2.out' });
  }

  // 完成勾选 → 金色小三角飘出（§11.6）
  _goldBurst(anchor) {
    if (REDUCED) return;
    const rect = anchor.getBoundingClientRect();
    for (let k = 0; k < 6; k++) {
      const s = document.createElement('span');
      s.className = 'burst-tri';
      s.style.left = `${rect.left + 22}px`;
      s.style.top = `${rect.top + rect.height / 2}px`;
      document.body.appendChild(s);
      gsap.to(s, {
        x: (Math.random() - 0.5) * 90,
        y: -20 - Math.random() * 60,
        rotation: Math.random() * 260 - 130,
        opacity: 0,
        duration: 0.8 + Math.random() * 0.4,
        ease: 'power2.out',
        onComplete: () => s.remove(),
      });
    }
  }

  // ── 日程时间线 ─────────────────────────────────
  _renderSchedule(highlightTitle) {
    const tl = this.$('timeline');
    tl.innerHTML = '';
    this.schedule.forEach(item => {
      const row = document.createElement('div');
      row.className = 'tl-item' + (item.current ? ' current' : '') + (item.moved ? ' moved' : '');
      row.style.minHeight = `${Math.max(40, item.dur * 60 * 0.6)}px`;
      row.innerHTML = `
        <span class="tl-time num">${item.time}</span>
        <span class="tl-dot" aria-hidden="true"></span>
        <div class="tl-body">
          <span class="tl-title">${item.title}</span>
          ${item.current ? '<span class="tl-state">专注中…</span>' : ''}
          ${item.tip ? `<span class="tl-tip">💡 ${item.tip} <button class="tl-adopt">采用</button></span>` : ''}
        </div>`;
      const adoptBtn = row.querySelector('.tl-adopt');
      if (adoptBtn) adoptBtn.addEventListener('click', () => this._adoptTip());
      tl.appendChild(row);
      if (highlightTitle && item.title === highlightTitle && !REDUCED) {
        gsap.fromTo(row, { backgroundColor: 'rgba(245,200,66,0.25)' },
          { backgroundColor: 'rgba(245,200,66,0)', duration: 1.6, ease: 'power2.out' });
      }
    });
  }

  // AI 调整日程：回复邮件 17:30 → 13:30（§11.8 对话触发布局动作）
  _adoptTip() {
    const idx = this.schedule.findIndex(s => s.title === '回复邮件');
    if (idx >= 0) {
      const [item] = this.schedule.splice(idx, 1);
      item.time = '13:30';
      item.tip = null;
      item.moved = true;
      this.schedule.splice(1, 0, item); // 午休后
      this._renderSchedule('回复邮件');
    }
    this.$('todo-tip').classList.add('dismissed');
    this._stream('好的，已把「回复邮件」挪到 13:30 午休后。\n上午全力写论文。');
  }

  // ── AI 流式对话（§11.8：15-20 字符/秒 + 闪烁光标）──
  _stream(text) {
    const el = this.$('chat-msg');
    this._stopStream();
    if (REDUCED) { el.textContent = text; return; }
    el.innerHTML = '<span class="cursor">│</span>';
    let i = 0;
    const cps = 18; // 字符/秒
    this.streamTimer = setInterval(() => {
      i += 1;
      const slice = text.slice(0, i);
      el.innerHTML = slice.replace(/\n/g, '<br>') + '<span class="cursor">│</span>';
      if (i >= text.length) {
        this._stopStream();
        setTimeout(() => { if (!this.streamTimer) el.innerHTML = slice.replace(/\n/g, '<br>'); }, 1600);
      }
    }, 1000 / cps);
  }

  _stopStream() {
    if (this.streamTimer) { clearInterval(this.streamTimer); this.streamTimer = null; }
  }

  _renderChips(chips) {
    const box = this.$('chat-chips');
    box.innerHTML = '';
    chips.forEach(c => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = c;
      b.addEventListener('click', () => this._chipReply(c));
      box.appendChild(b);
    });
  }

  _chipReply(text) {
    if (text === '把邮件挪到下午') {
      this._adoptTip();
    } else if (text === '帮我拆分论文任务') {
      this.todos.splice(1, 0,
        { t: '论文大纲 (20min)', done: false },
        { t: '论文初稿 (60min)', done: false });
      this._renderTodos();
      this._stream('论文拆好了：① 大纲 20 分钟 ② 初稿 60 分钟 ③ 修改 30 分钟。\n已加入待办，从大纲开始吧。');
    }
    this._renderChips([]);
  }

  _sendChat() {
    const input = this.$('chat-input');
    const text = input.value.trim();
    if (!text) return;
    if (text.includes('邮件')) { input.value = ''; this._adoptTip(); return; }
    this.todos.push({ t: text, done: false });
    input.value = '';
    this._renderTodos();
    this._stream(`记下了，「${text}」已加入待办。\n我会看着进度——你专心，我在看书。`);
  }

  // ── 计时 / 时钟 ────────────────────────────────
  _tickClock() {
    const now = new Date();
    this.$('wb-clock').textContent =
      `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }

  tick(dt) {
    if (!this.open) return;
    this.focusSec += dt;
    this.$('timer-num').textContent = fmt(this.focusSec);
    this.$('wb-focus-time').textContent = `专注 ${fmt(this.focusSec)}`;
    const left = Math.max(0, TARGET_MIN * 60 - this.focusSec);
    this.$('timer-left').textContent = left > 0 ? `还剩 ${Math.ceil(left / 60)} 分钟` : '目标达成 🎉';
    this.$('timer-bar-fill').style.width = `${Math.min(100, (this.focusSec / (TARGET_MIN * 60)) * 100)}%`;
    this.$('today-plants').textContent = this.onPlantsToday();
    if (Math.floor(this.focusSec * 2) !== Math.floor((this.focusSec - dt) * 2)) this._tickClock();
  }
}
