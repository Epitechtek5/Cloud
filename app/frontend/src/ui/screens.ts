function card(root: HTMLElement): { el: HTMLElement; remove: () => void } {
  const el = document.createElement('div');
  el.className = 'screen';
  root.append(el);
  return { el, remove: () => el.remove() };
}

/** Full-screen status message (connecting, errors). Returns a function that removes it. */
export function showMessage(root: HTMLElement, text: string, kind: 'info' | 'error' = 'info'): () => void {
  const { el, remove } = card(root);
  const p = document.createElement('p');
  p.className = kind === 'error' ? 'error' : 'muted';
  p.textContent = text;
  el.append(p);
  return remove;
}

export function showLogin(root: HTMLElement, onLogin: () => void, error?: string): () => void {
  const { el, remove } = card(root);
  const h = document.createElement('h1');
  h.textContent = 'Pixel Canvas';
  const b = document.createElement('button');
  b.className = 'login';
  b.textContent = 'Login with Discord';
  b.onclick = () => {
    b.disabled = true;
    onLogin();
  };
  el.append(h, b);
  if (error) {
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = error;
    el.append(p);
  }
  return remove;
}

/** Username (and logout in the browser) in the top bar. */
export function addUserBadge(bar: Element | null, name: string, onLogout?: () => void): void {
  if (!bar) return;
  const span = document.createElement('span');
  span.className = 'user';
  span.textContent = name;
  bar.append(span);
  if (onLogout) {
    const b = document.createElement('button');
    b.className = 'logout';
    b.textContent = 'Logout';
    b.onclick = onLogout;
    bar.append(b);
  }
}
