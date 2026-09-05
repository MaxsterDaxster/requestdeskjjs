/* ---------------------------------------------------------------
   Request Desk — local-only ticketing app for piano sheet requests
   All data lives in localStorage. No backend, no accounts, no quota.
----------------------------------------------------------------- */

const STORAGE_KEY = 'requestdesk:v1';

const defaultState = {
  config: {
    clientId: '',
    apiKey: '',
    channelId: '',
    fetchedVideoIds: []
  },
  inbox: [],   // [{id, author, text, publishedAt, videoTitle, videoId, category}]
  tickets: []  // [{id, song, requester, excerpt, category, status, priority, dueDate, notes, sourceCommentId, createdAt}]
};

let state = loadState();

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return structuredClone(defaultState);
    const parsed = JSON.parse(raw);
    return Object.assign(structuredClone(defaultState), parsed);
  }catch(e){
    console.error('Failed to load state, starting fresh.', e);
    return structuredClone(defaultState);
  }
}

let saveTimer = null;
function saveState(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  const indicator = document.getElementById('autosave-indicator');
  indicator.textContent = 'Saved just now';
  indicator.classList.remove('on');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    indicator.textContent = 'All changes saved locally';
  }, 1500);
}

function uid(){
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/* ---------------------------------------------------------------
   Classification heuristic — no external AI call, runs instantly
----------------------------------------------------------------- */

const SPAM_PATTERNS = [
  /subscribe to my channel/i,
  /check out my (channel|video)/i,
  /https?:\/\/(?!.*youtube\.com)/i,
  /free (v-?bucks|robux|gift card)/i,
  /(^|\s)(dm|whatsapp) me/i
];

const REQUEST_PATTERNS = [
  /can you (play|make|do|arrange)/i,
  /could you (play|make|do|arrange)/i,
  /please (make|play|do|arrange)/i,
  /request/i,
  /sheet music for/i,
  /next (song|one) should be/i,
  /do .* next/i,
  /add .* to your list/i
];

const QUESTION_PATTERNS = [
  /\?\s*$/,
  /^(how|what|when|why|which|is|are|do|does|did)\b/i,
  /difficulty/i,
  /what (bpm|key|tempo)/i
];

const FEEDBACK_PATTERNS = [
  /thank you|thanks/i,
  /amazing|awesome|beautiful|incredible|perfect/i,
  /love (this|it|your)/i,
  /great job|well done/i
];

function classifyComment(text){
  for(const p of SPAM_PATTERNS) if(p.test(text)) return 'spam';
  for(const p of REQUEST_PATTERNS) if(p.test(text)) return 'request';
  for(const p of QUESTION_PATTERNS) if(p.test(text)) return 'question';
  for(const p of FEEDBACK_PATTERNS) if(p.test(text)) return 'feedback';
  return 'other';
}

function guessSongTitle(text){
  // Best-effort extraction: text after "for", or quoted text
  let m = text.match(/["“']([^"”']{2,50})["”']/);
  if(m) return m[1];
  m = text.match(/\bfor ([A-Z][^.,!?]{2,40})/);
  if(m) return m[1].trim();
  m = text.match(/\bplay ([A-Z][^.,!?]{2,40})/i);
  if(m) return m[1].trim();
  return '';
}

/* ---------------------------------------------------------------
   Tabs
----------------------------------------------------------------- */

document.querySelectorAll('nav.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
  });
});

/* ---------------------------------------------------------------
   Inbox rendering
----------------------------------------------------------------- */

const CATEGORY_LABELS = {
  request: 'Request',
  question: 'Question',
  feedback: 'Feedback',
  spam: 'Spam',
  other: 'Other'
};

function renderInbox(){
  const list = document.getElementById('inbox-list');
  const items = state.inbox;
  document.getElementById('inbox-count').textContent = items.length ? `(${items.length})` : '';

  if(items.length === 0){
    list.innerHTML = `<div class="empty-state">
      <h3>Nothing to triage</h3>
      <p>Fetch comments from YouTube or paste some in to get started.</p>
    </div>`;
    return;
  }

  list.innerHTML = items.map(item => `
    <div class="comment-row" data-id="${item.id}">
      <div>
        <div class="meta">
          <span class="badge ${item.category}">${CATEGORY_LABELS[item.category]}</span>
          <span>${escapeHtml(item.author || 'Unknown')}</span>
          ${item.videoTitle ? `<span>· ${escapeHtml(item.videoTitle)}</span>` : ''}
        </div>
        <div class="text">${escapeHtml(item.text)}</div>
      </div>
      <div class="actions">
        <select class="recat" data-action="recategorize">
          ${Object.entries(CATEGORY_LABELS).map(([k,v]) =>
            `<option value="${k}" ${k===item.category?'selected':''}>${v}</option>`).join('')}
        </select>
        <button class="btn primary" data-action="make-ticket">Make ticket</button>
        <button class="btn subtle" data-action="dismiss">Dismiss</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.comment-row').forEach(row => {
    const id = row.dataset.id;
    row.querySelector('[data-action=recategorize]').addEventListener('change', (e) => {
      const item = state.inbox.find(i => i.id === id);
      item.category = e.target.value;
      saveState();
      renderInbox();
    });
    row.querySelector('[data-action=make-ticket]').addEventListener('click', () => makeTicketFromComment(id));
    row.querySelector('[data-action=dismiss]').addEventListener('click', () => {
      state.inbox = state.inbox.filter(i => i.id !== id);
      saveState();
      renderInbox();
    });
  });
}

function makeTicketFromComment(commentId){
  const item = state.inbox.find(i => i.id === commentId);
  if(!item) return;
  const ticket = {
    id: uid(),
    song: guessSongTitle(item.text) || '(untitled — edit song name)',
    requester: item.author || 'Unknown',
    excerpt: item.text,
    category: item.category,
    status: 'todo',
    priority: 'medium',
    dueDate: '',
    notes: '',
    sourceCommentId: item.videoId ? `https://www.youtube.com/watch?v=${item.videoId}` : '',
    createdAt: Date.now()
  };
  state.tickets.unshift(ticket);
  state.inbox = state.inbox.filter(i => i.id !== commentId);
  saveState();
  renderInbox();
  renderBoard();
}

function escapeHtml(str){
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

/* ---------------------------------------------------------------
   Board rendering
----------------------------------------------------------------- */

function renderBoard(){
  const cols = { todo: [], progress: [], done: [] };
  state.tickets.forEach(t => cols[t.status]?.push(t));

  document.getElementById('board-count').textContent = state.tickets.length ? `(${state.tickets.length})` : '';
  document.getElementById('col-count-todo').textContent = cols.todo.length || '';
  document.getElementById('col-count-progress').textContent = cols.progress.length || '';
  document.getElementById('col-count-done').textContent = cols.done.length || '';

  document.getElementById('col-todo').innerHTML = cols.todo.map(renderTicket).join('') || emptyCol();
  document.getElementById('col-progress').innerHTML = cols.progress.map(renderTicket).join('') || emptyCol();
  document.getElementById('col-done').innerHTML = cols.done.map(renderTicket).join('') || emptyCol();

  attachTicketHandlers();
}

function emptyCol(){
  return `<div style="color:var(--ink-soft);font-size:13px;padding:20px 0;">Nothing here.</div>`;
}

function renderTicket(t){
  return `
  <div class="ticket priority-${t.priority}" data-id="${t.id}">
    <div class="song" contenteditable="true" data-field="song">${escapeHtml(t.song)}</div>
    <div class="who">requested by ${escapeHtml(t.requester)} · <span class="badge ${t.category}">${CATEGORY_LABELS[t.category]}</span></div>
    <div class="excerpt">${escapeHtml(t.excerpt)}</div>
    <div class="row-line">
      <select data-field="status">
        <option value="todo" ${t.status==='todo'?'selected':''}>To do</option>
        <option value="progress" ${t.status==='progress'?'selected':''}>In progress</option>
        <option value="done" ${t.status==='done'?'selected':''}>Done</option>
      </select>
      <select data-field="priority">
        <option value="low" ${t.priority==='low'?'selected':''}>Low</option>
        <option value="medium" ${t.priority==='medium'?'selected':''}>Medium</option>
        <option value="high" ${t.priority==='high'?'selected':''}>High</option>
      </select>
      <input type="date" data-field="dueDate" value="${t.dueDate || ''}">
    </div>
    <textarea data-field="notes" placeholder="Notes...">${escapeHtml(t.notes)}</textarea>
    <div class="footer">
      ${t.sourceCommentId ? `<a href="${t.sourceCommentId}" target="_blank" style="font-size:12px;">View source</a>` : '<span></span>'}
      <span>
        <span class="saved" data-role="saved">Saved</span>
        <button class="btn subtle" data-action="delete-ticket" style="color:var(--red);">Delete</button>
      </span>
    </div>
  </div>`;
}

function attachTicketHandlers(){
  document.querySelectorAll('.ticket').forEach(el => {
    const id = el.dataset.id;
    const ticket = state.tickets.find(t => t.id === id);
    if(!ticket) return;

    const flashSaved = () => {
      const s = el.querySelector('[data-role=saved]');
      s.classList.add('show');
      setTimeout(() => s.classList.remove('show'), 1200);
    };

    el.querySelectorAll('[data-field]').forEach(field => {
      const key = field.dataset.field;
      const evt = (field.tagName === 'SELECT' || field.type === 'date') ? 'change' : 'input';
      field.addEventListener(evt, () => {
        const val = field.tagName === 'DIV' ? field.textContent : field.value;
        ticket[key] = val;
        saveState();
        flashSaved();
        if(key === 'priority' || key === 'status'){
          renderBoard();
        }
      });
    });

    el.querySelector('[data-action=delete-ticket]').addEventListener('click', () => {
      if(!confirm('Delete this ticket? This cannot be undone.')) return;
      state.tickets = state.tickets.filter(t => t.id !== id);
      saveState();
      renderBoard();
    });
  });
}

/* ---------------------------------------------------------------
   Manual paste
----------------------------------------------------------------- */

document.getElementById('paste-btn').addEventListener('click', () => {
  const raw = prompt('Paste comments, one per line (format: "Author: comment text" or just the text):');
  if(!raw) return;
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  lines.forEach(line => {
    let author = '', text = line;
    const m = line.match(/^([^:]{1,40}):\s*(.+)$/);
    if(m){ author = m[1]; text = m[2]; }
    state.inbox.unshift({
      id: uid(),
      author,
      text,
      publishedAt: Date.now(),
      videoTitle: '',
      videoId: '',
      category: classifyComment(text)
    });
  });
  saveState();
  renderInbox();
});

/* ---------------------------------------------------------------
   YouTube OAuth + fetch (Google Identity Services token flow)
----------------------------------------------------------------- */

let tokenClient = null;
let accessToken = null;

function loadConfigIntoInputs(){
  document.getElementById('cfg-client-id').value = state.config.clientId;
  document.getElementById('cfg-api-key').value = state.config.apiKey;
  document.getElementById('cfg-channel-id').value = state.config.channelId;
}

['cfg-client-id','cfg-api-key','cfg-channel-id'].forEach(id => {
  document.getElementById(id).addEventListener('input', (e) => {
    const map = { 'cfg-client-id':'clientId', 'cfg-api-key':'apiKey', 'cfg-channel-id':'channelId' };
    state.config[map[id]] = e.target.value.trim();
    saveState();
  });
});

document.getElementById('signin-btn').addEventListener('click', () => {
  if(!state.config.clientId){
    alert('Enter your OAuth client ID first (see README for how to create one).');
    return;
  }
  if(!window.google || !google.accounts){
    alert('Google sign-in script has not loaded yet. Check your connection and try again.');
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: state.config.clientId,
    scope: 'https://www.googleapis.com/auth/youtube.readonly',
    callback: (resp) => {
      if(resp.error){
        alert('Sign-in failed: ' + resp.error);
        return;
      }
      accessToken = resp.access_token;
      document.getElementById('signin-status').textContent = 'Signed in';
      document.getElementById('signin-status').classList.add('on');
    }
  });
  tokenClient.requestAccessToken();
});

document.getElementById('fetch-btn').addEventListener('click', fetchComments);

async function fetchComments(){
  const statusEl = document.getElementById('inbox-status');
  if(!state.config.apiKey){
    statusEl.textContent = 'Add your YouTube API key in Settings first.';
    return;
  }
  if(!state.config.channelId){
    statusEl.textContent = 'Add your channel ID in Settings first.';
    return;
  }

  statusEl.textContent = 'Fetching recent videos...';
  try{
    // 1. Get recent videos from the channel's uploads
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?key=${state.config.apiKey}&channelId=${state.config.channelId}&part=snippet,id&order=date&maxResults=10&type=video`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();
    if(searchData.error){
      statusEl.textContent = 'YouTube API error: ' + searchData.error.message;
      return;
    }
    const videos = (searchData.items || []).map(it => ({
      id: it.id.videoId,
      title: it.snippet.title
    }));

    let newCount = 0;
    for(const video of videos){
      statusEl.textContent = `Fetching comments for "${video.title}"...`;
      const commentsUrl = `https://www.googleapis.com/youtube/v3/commentThreads?key=${state.config.apiKey}&videoId=${video.id}&part=snippet&maxResults=50&order=time`;
      const cRes = await fetch(commentsUrl);
      const cData = await cRes.json();
      if(cData.error) continue; // comments may be disabled on some videos
      (cData.items || []).forEach(item => {
        const c = item.snippet.topLevelComment.snippet;
        const commentId = item.id;
        const alreadyKnown = state.inbox.some(i => i.ytCommentId === commentId) ||
                              state.tickets.some(t => t.ytCommentId === commentId);
        if(alreadyKnown) return;
        state.inbox.unshift({
          id: uid(),
          ytCommentId: commentId,
          author: c.authorDisplayName,
          text: c.textDisplay.replace(/<[^>]+>/g, ''),
          publishedAt: c.publishedAt,
          videoTitle: video.title,
          videoId: video.id,
          category: classifyComment(c.textDisplay)
        });
        newCount++;
      });
    }
    saveState();
    renderInbox();
    statusEl.textContent = `Done — ${newCount} new comment${newCount === 1 ? '' : 's'} added to the inbox.`;
  }catch(e){
    console.error(e);
    statusEl.textContent = 'Something went wrong fetching comments. Check your API key and channel ID.';
  }
}

/* ---------------------------------------------------------------
   Export / import / clear
----------------------------------------------------------------- */

document.getElementById('export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `request-desk-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('import-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const imported = JSON.parse(reader.result);
      if(!confirm('This will merge imported tickets and inbox items with your current data. Continue?')) return;
      state.tickets = [...imported.tickets || [], ...state.tickets];
      state.inbox = [...imported.inbox || [], ...state.inbox];
      if(imported.config){
        state.config = Object.assign(state.config, imported.config);
      }
      saveState();
      loadConfigIntoInputs();
      renderInbox();
      renderBoard();
      alert('Import complete.');
    }catch(err){
      alert('Could not read that file — make sure it is a Request Desk export.');
    }
  };
  reader.readAsText(file);
});

document.getElementById('clear-btn').addEventListener('click', () => {
  if(!confirm('This deletes every ticket, inbox item, and saved setting from this browser. This cannot be undone. Continue?')) return;
  state = structuredClone(defaultState);
  saveState();
  loadConfigIntoInputs();
  renderInbox();
  renderBoard();
});

/* ---------------------------------------------------------------
   Init
----------------------------------------------------------------- */

loadConfigIntoInputs();
renderInbox();
renderBoard();
