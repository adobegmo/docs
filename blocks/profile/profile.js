import { loadIms, handleSignIn, handleSignOut } from '../../scripts/utils/ims.js';

/*
 * Profile / sign-out menu for the site header. Plain DOM (no Lit): a Sign-in
 * button when signed out, or an avatar button + native Popover (display name,
 * email, Sign out) when signed in. Auth state, identity, and sign-out come from
 * scripts/utils/ims.js (imslib). Mounted by blocks/header/header.js.
 */

const initialOf = (name, email) => {
  const src = (name || email || '?').trim();
  return src ? src[0].toUpperCase() : '?';
};

const buildAvatar = (avatar, initial) => {
  if (avatar) {
    const img = document.createElement('img');
    img.src = avatar;
    img.alt = '';
    img.className = 'profile-avatar-img';
    return img;
  }
  const span = document.createElement('span');
  span.className = 'profile-initials';
  span.textContent = initial;
  span.setAttribute('aria-hidden', 'true');
  return span;
};

const buildSignIn = () => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'profile-signin';
  btn.textContent = 'Sign in';
  btn.addEventListener('click', handleSignIn);
  return btn;
};

const buildProfile = (details, avatar) => {
  const frag = document.createDocumentFragment();
  const name = details.displayName || details.email || 'Account';
  const initial = initialOf(details.displayName, details.email);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'profile-avatar';
  button.setAttribute('popovertarget', 'profile-popover');
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-label', `Account menu, ${name}`);
  button.append(buildAvatar(avatar, initial));

  const popover = document.createElement('div');
  popover.id = 'profile-popover';
  popover.className = 'profile-popover';
  popover.setAttribute('popover', '');

  const row = document.createElement('div');
  row.className = 'profile-details';
  const bigAvatar = buildAvatar(avatar, initial);
  bigAvatar.classList.add('profile-details-avatar');
  const nameWrap = document.createElement('div');
  nameWrap.className = 'profile-name';
  const displayName = document.createElement('p');
  displayName.className = 'profile-display-name';
  displayName.textContent = name;
  const email = document.createElement('p');
  email.className = 'profile-email';
  email.textContent = details.email || '';
  nameWrap.append(displayName, email);
  row.append(bigAvatar, nameWrap);

  const signout = document.createElement('button');
  signout.type = 'button';
  signout.className = 'profile-signout';
  signout.textContent = 'Sign out';
  signout.addEventListener('click', handleSignOut);

  popover.append(row, signout);
  frag.append(button, popover);
  return frag;
};

export default async function init(el) {
  let details;
  try {
    details = await loadIms();
  } catch (e) {
    details = { anonymous: true };
  }

  if (details.anonymous) {
    el.append(buildSignIn());
    return;
  }

  let avatar = null;
  try {
    const io = await details.getIo();
    avatar = io?.user?.avatar || null;
  } catch (e) {
    avatar = null;
  }

  el.append(buildProfile(details, avatar));
}
