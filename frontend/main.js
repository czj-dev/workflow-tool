import { ListActions, RunAction, CancelAction } from './bindings/workflow-tool/internal/api/service.js';
import { Events } from '@wailsio/runtime';

const list = document.getElementById('action-list');
const output = document.getElementById('output');
const currentTitle = document.getElementById('current-title');
const stopBtn = document.getElementById('stop-btn');

let currentId = null;
let unsubs = [];

function unsubscribeAll() { unsubs.forEach(fn => fn && fn()); unsubs = []; }

function subscribe(id) {
  unsubs.push(Events.On(`action:${id}:output`, (e) => {
    const d = (e && e.data) || {};
    const prefix = d.stream === 'stderr' ? '[stderr] ' : '';
    output.textContent += prefix + (d.line || '') + '\n';
    output.scrollTop = output.scrollHeight;
  }));
  unsubs.push(Events.On(`action:${id}:done`, (e) => {
    const d = (e && e.data) || {};
    output.textContent += `\n--- 退出码 ${d.exitCode}${d.err ? '  错误: ' + d.err : ''} ---\n`;
    stopBtn.disabled = true;
  }));
}

async function runAction(a) {
  unsubscribeAll();
  output.textContent = '';
  currentTitle.textContent = (a.icon || '▶') + ' ' + a.title;
  currentId = a.id;
  stopBtn.disabled = false;
  subscribe(a.id);
  try {
    await RunAction(a.id);
  } catch (err) {
    output.textContent += '启动失败: ' + err + '\n';
    stopBtn.disabled = true;
  }
}

stopBtn.addEventListener('click', () => {
  if (currentId) CancelAction(currentId);
});

async function load() {
  try {
    const result = await ListActions();
    const data = result || {};
    const actions = data.actions || [];
    const errors = data.errors || [];
    if (!actions.length && !errors.length) {
      const li = document.createElement('li');
      li.textContent = '（无动作，在 actions/ 放 YAML）';
      li.style.color = '#71717a';
      list.appendChild(li);
    }
    for (const a of actions) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.textContent = (a.icon || '▶') + ' ' + a.title;
      btn.title = a.description || '';
      btn.addEventListener('click', () => runAction(a));
      li.appendChild(btn);
      list.appendChild(li);
    }
    if (errors.length) {
      const li = document.createElement('li');
      li.textContent = '⚠ ' + errors.join('; ');
      li.style.color = '#dc2626';
      list.appendChild(li);
    }
  } catch (err) {
    const li = document.createElement('li');
    li.textContent = '加载失败: ' + err;
    li.style.color = '#dc2626';
    list.appendChild(li);
  }
}

load();
