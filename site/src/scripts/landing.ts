// Landing page behaviour: copy-to-clipboard buttons, scroll reveals, card tilt, and the scripted terminal demo.
// The demo replays a realistic Rein session using the real UI strings (route line, tool lines,
// load-balancing notice, goal verification). It's illustrative: timings are sped up.

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy ?? '');
      btn.classList.add('done');
      setTimeout(() => btn.classList.remove('done'), 1400);
    } catch {
      /* clipboard blocked: nothing to do */
    }
  });
}

// Sections fade up as they scroll into view.
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) if (e.isIntersecting) (e.target.classList.add('in'), io.unobserve(e.target));
  },
  {threshold: 0.15},
);
for (const el of document.querySelectorAll('.reveal')) io.observe(el);

// Each row's mini terminal plays its lines in when it scrolls into view.
const play = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      play.unobserve(e.target);
      const pre = e.target as HTMLElement;
      const lines = (pre.dataset.html ?? '').split('\n');
      pre.innerHTML = '';
      lines.forEach((html, i) =>
        setTimeout(() => {
          pre.querySelector('.cur')?.remove();
          pre.insertAdjacentHTML('beforeend', `<span class="ln-in">${html || ' '}${i === lines.length - 1 ? '<span class="cur"></span>' : ''}</span>`);
        }, 250 + i * 380),
      );
    }
  },
  {threshold: 0.4},
);
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  for (const pre of document.querySelectorAll<HTMLElement>('.row-code')) {
    pre.dataset.html = pre.innerHTML;
    pre.innerHTML = '';
    play.observe(pre);
  }
}

// Cards tilt toward the pointer, a few degrees.
if (!matchMedia('(prefers-reduced-motion: reduce)').matches && matchMedia('(hover: hover)').matches) {
  for (const el of document.querySelectorAll<HTMLElement>('.tilt')) {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = `perspective(900px) rotateY(${x * 6}deg) rotateX(${-y * 6}deg) translateZ(0)`;
    });
    el.addEventListener('pointerleave', () => (el.style.transform = ''));
  }
}

const $ = (id: string) => document.getElementById(id)!;
const history = document.getElementById('history');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

if (history) {
  const typed = $('typed');
  const activity = $('activity');
  const idleHint = activity.innerHTML;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, reduced ? Math.min(ms, 60) : ms));
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

  const line = (html: string) => {
    const el = document.createElement('div');
    el.className = 'ln';
    el.innerHTML = html;
    history.appendChild(el);
    while (history.children.length > 26) history.firstElementChild?.remove();
    return el;
  };
  const gap = () => {
    const el = document.createElement('div');
    el.className = 'gap';
    history.appendChild(el);
  };

  // The working indicator: a 4-cell bar wave with a rainbow flowing through bar + label.
  const WAVE = ['▇▅▃▁', '▅▇▅▃', '▃▅▇▅', '▁▃▅▇', '▃▅▇▅', '▅▇▅▃'];
  let spin: number | undefined;
  let tick = 0;
  const working = (label: string, meta: string) => {
    stopWorking();
    const t0 = Date.now();
    const paint = () => {
      tick++;
      const wave = WAVE[tick % WAVE.length]!;
      const colored = [...(wave + ' ' + label)]
        .map((ch, i) => (ch === ' ' ? ' ' : `<span style="color:hsl(${(i * 24 + tick * 14) % 360} 85% 66%)">${esc(ch)}</span>`))
        .join('');
      const secs = Math.floor((Date.now() - t0) / 1000);
      activity.innerHTML = `<span class="wave">${colored}</span> <span class="t-dim">(${secs}s · ${meta} · esc to interrupt · /btw to ask)</span>`;
    };
    paint();
    spin = window.setInterval(paint, 110);
  };
  function stopWorking() {
    if (spin) clearInterval(spin);
    spin = undefined;
    activity.innerHTML = idleHint;
  }

  const type = async (text: string) => {
    typed.textContent = '';
    for (const ch of text) {
      typed.textContent += ch;
      await sleep(28 + Math.random() * 40);
    }
    await sleep(420);
  };

  const setMs = (n: number) => {
    for (let i = 1; i <= 3; i++) {
      const el = $(`ms${i}`);
      el.classList.toggle('done', i <= n);
      el.classList.toggle('next', i === n + 1);
      el.querySelector('b')!.textContent = i <= n ? '✓' : i === n + 1 ? '▸' : '○';
    }
    $('sb-goal-n').textContent = `${n}/3`;
    ($('sb-goal-bar') as HTMLElement).style.width = `${(n / 3) * 100}%`;
    $('tb-goal').textContent = n === 3 ? '◎ goal · done · 3/3' : `◎ goal · active · ${n}/3`;
    $('tb-goal').className = (n === 3 ? 't-green' : 't-cyan') + ' hide-sm';
  };

  const meter = (id: string, pct: number) => {
    const bar = $(id) as HTMLElement;
    bar.style.width = `${pct}%`;
    bar.className = pct >= 90 ? 'warn' : pct >= 70 ? 'mid' : '';
    $(`${id}p`).textContent = `${pct}%`;
  };

  const reset = () => {
    history.innerHTML = '';
    setMs(0);
    meter('a1', 84);
    meter('a2', 9);
    $('tb-acct').textContent = 'Claude Account 1';
    $('tb-usage').textContent = '5h 84% · weekly 31%';
    $('tb-ctx').textContent = 'ctx 12%';
    ($('sb-agent') as HTMLElement).style.opacity = '.35';
    stopWorking();
  };

  const tool = (ok: boolean | null, name: string, args: string, note = '') =>
    line(`${ok === null ? '<span class="t-yellow">⏺</span>' : ok ? '<span class="t-green">⏺</span>' : '<span class="t-red">⏺</span>'} <span class="t-bold">${name}</span><span class="t-dim">(${esc(args)})${esc(note)}</span>`);

  const run = async () => {
    for (;;) {
      reset();
      await sleep(700);
      await type('/goal make the failing auth tests pass — prove it');
      typed.textContent = '';
      line(`<span class="t-cyan">›</span> /goal make the failing auth tests pass — prove it`);
      line(`<span class="t-cyan">◎ Goal set: make the failing auth tests pass — prove it</span>`);
      line(`<span class="t-dim">  The agent keeps working until the decision model verifies it's done (evidence required).</span>`);
      gap();
      working('Routing…', '↑ 0 ↓ 0');
      await sleep(900);
      line(`<span class="t-dim">  → Opus · effort high · Claude Account 1 (auto · 0.91)</span>`);
      working('Shell…', '↑ 14.2k ↓ 310');
      await sleep(1100);
      tool(false, 'Shell', 'npm test -- auth', ' · allowed by rule');
      line(`<span class="t-red">  ✗ 3 failed</span><span class="t-dim">, 15 passed · session.test.ts: token expired 1h early</span>`);
      setMs(1);
      working('Read…', '↑ 16.8k ↓ 520');
      await sleep(800);
      tool(true, 'Read', 'src/auth/session.ts', ' Read 212 lines');

      // /btw while the agent keeps working
      working('Thinking…', '↑ 19.1k ↓ 880');
      await sleep(500);
      await type('/btw why did the tests fail?');
      typed.textContent = '';
      const btw = $('btw');
      const body = $('btw-body');
      body.textContent = '';
      btw.classList.add('show');
      const answer = 'expiresAt is computed in seconds but compared against Date.now() in milliseconds — sessions look expired immediately after the 1h mark.';
      for (const word of answer.split(' ')) {
        body.textContent += word + ' ';
        await sleep(55);
      }
      await sleep(1600);
      btw.classList.remove('show');

      working('Edit…', '↑ 21.4k ↓ 1.2k');
      await sleep(700);
      tool(true, 'Edit', 'src/auth/session.ts', ' · auto-approved (0.94 via jev)');
      line(
        `<span class="diff"><span class="del"><span class="no"> 41</span>-  const expiresAt = issuedAt + <b>ttlSeconds</b>;</span><span class="add"><span class="no"> 41</span>+  const expiresAt = issuedAt + <b>ttlSeconds * 1000</b>;</span></span>`,
      );
      setMs(2);
      meter('a1', 93);
      $('tb-usage').textContent = '5h 93% · weekly 33%';
      await sleep(700);

      line(`<span class="t-yellow">  Load balancing: Claude Account 1 is near its limit — switching to Claude Account 2 before it's rejected</span>`);
      $('tb-acct').textContent = 'Claude Account 2';
      $('tb-usage').textContent = '5h 11% · weekly 4%';
      meter('a2', 11);
      await sleep(500);
      line(`<span class="t-magenta">⏺</span> <span class="t-bold">Agent</span><span class="t-dim">(test-runner · Haiku · new)</span>`);
      ($('sb-agent') as HTMLElement).style.opacity = '1';
      working('Shell…', '↑ 3.1k ↓ 240');
      await sleep(1300);
      tool(true, 'Shell', 'npm test', ' · allowed by rule');
      line(`<span class="t-green">  ✓ 48 passed</span><span class="t-dim"> · 0 failed · 4.2s</span>`);
      setMs(3);
      $('tb-ctx').textContent = 'ctx 19%';
      working('Goal: checking progress', '↑ 1.4k ↓ 60');
      await sleep(1100);
      stopWorking();
      gap();
      line(`<span class="t-green">◎ Goal achieved and verified: make the failing auth tests pass — prove it</span>`);
      line(`<span class="t-dim">  accepted (0.96 via jev)</span>`);
      await sleep(5200);
    }
  };

  // Start when the demo scrolls into view.
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      io.disconnect();
      run();
    }
  });
  io.observe(history);
}
