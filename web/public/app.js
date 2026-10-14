'use strict';
/**
 * 演示网页交互：输入采集数量上限 → 点击开始 → SSE 接收实时日志与进度 → 展示结果文件。
 */
(function () {
  const $ = (id) => document.getElementById(id);

  const limitInput = $('limitInput');
  const startBtn = $('startBtn');
  const stopBtn = $('stopBtn');
  const estimate = $('estimate');
  const statusBadge = $('statusBadge');
  const statusText = $('statusText');
  const stageTag = $('stageTag');
  const progressBar = $('progressBar');
  const progressText = $('progressText');
  const logView = $('logView');
  const autoScroll = $('autoScroll');
  const clearLog = $('clearLog');
  const resultPath = $('resultPath');
  const reportPath = $('reportPath');
  const openFolder = $('openFolder');
  const toast = $('toast');

  const metrics = {
    scanned: $('statScanned'),
    passed: $('statPassed'),
    rejected: $('statRejected'),
    verified: $('statVerified')
  };
  const metricCache = { scanned: null, passed: null, rejected: null, verified: null };

  let stream = null;

  function showToast(message, kind) {
    toast.textContent = message;
    toast.dataset.kind = kind || 'info';
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  function setStatus(state, text) {
    statusBadge.dataset.state = state;
    statusText.textContent = text;
  }

  function setMetric(key, value) {
    if (value === undefined || value === null) return;
    const el = metrics[key];
    if (!el) return;
    if (metricCache[key] === value) return;
    metricCache[key] = value;
    el.textContent = value;
    const box = el.closest('.metric');
    if (box) {
      box.classList.remove('bump');
      void box.offsetWidth;
      box.classList.add('bump');
    }
  }

  function appendLog(ev) {
    const line = document.createElement('div');
    line.className = 'line';
    line.dataset.level = ev.level || 'INFO';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = ev.time || '';
    const lvl = document.createElement('span');
    lvl.className = 'lvl';
    lvl.textContent = `[${ev.level || 'INFO'}]`;
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = ev.message || '';
    line.append(t, lvl, msg);
    logView.appendChild(line);
    while (logView.childElementCount > 800) logView.removeChild(logView.firstChild);
    if (autoScroll.checked) logView.scrollTop = logView.scrollHeight;

    if (ev.stats) {
      setMetric('scanned', ev.stats.scanned);
      setMetric('passed', ev.stats.passed ?? ev.stats.saved);
      setMetric('rejected', ev.stats.rejected);
      setMetric('verified', ev.stats.verified);
      if (ev.stats.stage && ev.stats.stage !== 'idle') stageTag.textContent = ev.stats.stage;
      const limit = Number(limitInput.value) || 0;
      if (limit > 0) {
        const pct = Math.min(100, Math.round(((ev.stats.passed || 0) / limit) * 100));
        progressBar.style.width = `${pct}%`;
        progressText.textContent = `${pct}%`;
      }
    }
    if (ev.level === 'WAIT') setStatus('waiting', '等待人工操作');
    if (ev.message && /登录/.test(ev.message) && ev.level === 'WAIT') setStatus('waiting', '等待登录');
    if (/采集|搜索|核验|导出/.test(ev.message || '') && ev.level === 'STAGE') setStatus('running', '运行中');
  }

  function connectStream() {
    if (stream) stream.close();
    stream = new EventSource('/api/stream');
    stream.addEventListener('log', (e) => {
      try {
        appendLog(JSON.parse(e.data));
      } catch (err) { /* ignore */ }
    });
    stream.addEventListener('state', (e) => {
      try {
        applyState(JSON.parse(e.data));
      } catch (err) { /* ignore */ }
    });
    stream.addEventListener('done', (e) => {
      try {
        const st = JSON.parse(e.data);
        applyState(st);
        if (st.error) {
          setStatus('error', '出错');
          showToast(`采集失败：${st.error}`, 'error');
        } else if (st.result && st.result.file) {
          setStatus('done', '已完成');
          showToast(`采集完成：通过 ${st.result.passed} 个场所`);
        } else {
          setStatus('done', '已完成');
          showToast('采集结束，但没有符合条件的场所');
        }
      } catch (err) { /* ignore */ }
    });
    stream.onerror = () => { /* 浏览器会自动重连 */ };
  }

  function applyState(st) {
    if (!st) return;
    if (st.stats) {
      setMetric('scanned', st.stats.scanned);
      setMetric('passed', st.stats.passed ?? st.stats.saved);
      setMetric('rejected', st.stats.rejected);
      setMetric('verified', st.stats.verified);
      if (st.stats.stage) stageTag.textContent = st.stats.stage;
    }
    if (typeof st.progress === 'number') {
      progressBar.style.width = `${st.progress}%`;
      progressText.textContent = `${st.progress}%`;
    }
    if (st.result && st.result.file) {
      resultPath.textContent = st.result.file;
      if (st.result.report) reportPath.textContent = `被过滤明细：${st.result.report.csvFile || ''}`;
    }
    if (st.running) {
      startBtn.disabled = true;
      stopBtn.disabled = false;
      if (statusBadge.dataset.state !== 'waiting') setStatus('running', '运行中');
    } else {
      startBtn.disabled = false;
      stopBtn.disabled = true;
      if (st.error) setStatus('error', '出错');
      else if (st.finishedAt) setStatus('done', '已完成');
      else setStatus('idle', '空闲');
    }
    if (st.error) showToast(`采集失败：${st.error}`, 'error');
  }

  async function start() {
    const limit = Number(limitInput.value);
    if (!Number.isInteger(limit) || limit <= 0) {
      showToast('请输入一个正整数作为采集数量上限', 'error');
      limitInput.focus();
      return;
    }
    startBtn.disabled = true;
    logView.innerHTML = '';
    progressBar.style.width = '0%';
    progressText.textContent = '0%';
    resultPath.textContent = '采集中…';
    reportPath.textContent = '';
    setStatus('running', '启动中');
    stageTag.textContent = '启动中';

    connectStream();
    try {
      const res = await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        startBtn.disabled = false;
        setStatus('error', '未启动');
        showToast(data.error || '启动失败', 'error');
        return;
      }
      stopBtn.disabled = false;
      showToast(data.message || '已开始采集');
      setStatus('waiting', '等待登录');
      logView.scrollTop = logView.scrollHeight;
    } catch (e) {
      startBtn.disabled = false;
      setStatus('error', '未启动');
      showToast(`启动失败：${e.message}`, 'error');
    }
  }

  async function stop() {
    stopBtn.disabled = true;
    try {
      await fetch('/api/stop', { method: 'POST' });
      showToast('已请求停止，正在收尾…');
    } catch (e) {
      showToast(`停止失败：${e.message}`, 'error');
    }
  }

  function updateEstimate() {
    const limit = Number(limitInput.value) || 0;
    if (limit <= 0) {
      estimate.textContent = '请输入数量上限';
      return;
    }
    const seconds = Math.max(30, limit * 24);
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    estimate.textContent = `预计耗时约 ${min > 0 ? `${min} 分 ` : ''}${sec} 秒（每条约 20~30 秒：详情页 + 点评搜索 + 店铺页核验；含登录等待）`;
  }

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);
  limitInput.addEventListener('input', updateEstimate);
  limitInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
  clearLog.addEventListener('click', () => { logView.innerHTML = ''; });
  openFolder.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/open-folder', { method: 'POST' });
      const data = await res.json();
      showToast(`已打开目录：${data.dir}`);
    } catch (e) {
      showToast(`打开目录失败：${e.message}`, 'error');
    }
  });

  updateEstimate();
  connectStream();
  fetch('/api/status').then((r) => r.json()).then(applyState).catch(() => {});
})();
