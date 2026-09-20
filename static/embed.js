/**
 * Browser-side embed example. The only transport is postMessage: this page never
 * calls the control API, remembers events, or needs a client ID or API key.
 */
const byId = (id) => document.getElementById(id);
const frame = byId('tv');
const MAX_CUSTOM_LAYOUT_BYTES = 10 * 1024 * 1024;
const CUSTOM_VARIABLE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;

let frameLoaded = false;
let apiReady = false;
let helloInterval;
let readyTimeout;
let nextRequestId = 1;
let customOverlayLayout;
let weatherOverlayLayoutPromise;

byId('parentOrigin').textContent = location.origin;

/** Post one message to the exact origin of the URL currently loaded in the frame. */
function postToTv(message, showMessage = true) {
  if (!frameLoaded || !frame.contentWindow) {
    return false;
  }

  // Use the loaded frame URL, not the editable input: editing the URL alone must
  // not change which origin receives a message.
  const targetOrigin = new URL(frame.src).origin;

  frame.contentWindow.postMessage(message, targetOrigin);

  if (showMessage) {
    byId('result').textContent = JSON.stringify(message, null, 2);
  }

  return true;
}

/** Send one of the same event names and payloads accepted by the SSE adapter. */
function send(event, data) {
  if (!apiReady) {
    byId('embedStatus').textContent = 'Wait for TVS.EmbedReady before sending a command.';
    return;
  }

  const targetOrigin = new URL(frame.src).origin;

  postToTv({ type: 'TVS.RemoteManagement', event, data });
  byId('embedStatus').textContent = `Sent ${event} to ${targetOrigin}.`;
}

/** Load a TVS instance configured with remoteManagement.type: embed. */
function loadTv() {
  try {
    const url = new URL(byId('tvsUrl').value, location.href);

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Use an HTTP or HTTPS URL.');
    }

    frameLoaded = false;
    apiReady = false;

    clearInterval(helloInterval);
    clearTimeout(readyTimeout);

    setCommandControlsEnabled(false);

    byId('apiStatus').textContent = 'Waiting for TVS.EmbedReady…';
    byId('embedStatus').textContent = 'Loading TVS…';

    delete byId('embedStatus').dataset.state;
    frame.src = url.href;
  } catch (error) {
    byId('embedStatus').textContent = `Could not load TVS: ${error.message}`;
  }
}

/** Enable every command panel only after TVS confirms that its handlers are installed. */
function setCommandControlsEnabled(enabled) {
  document.querySelectorAll('[data-embed-command-controls]').forEach((fieldset) => {
    fieldset.disabled = !enabled;
  });
}

function apiRequest(type, data = {}) {
  if (!apiReady) {
    return;
  }

  const message = { type, requestId: `demo-${nextRequestId++}`, ...data };

  postToTv(message);
  byId('apiStatus').textContent = `Waiting for ${type.replace('TVS.Get', 'TVS.')}…`;
}

/** Accept status and guide replies only from the loaded TVS frame and its exact origin. */
function handleTvMessage(event) {
  if (!frame.contentWindow || event.source !== frame.contentWindow || event.origin !== new URL(frame.src).origin
    || !event.data || typeof event.data !== 'object') {
    return;
  }

  const message = event.data;

  if (message.type === 'TVS.EmbedReady') {
    apiReady = true;

    clearInterval(helloInterval);
    clearTimeout(readyTimeout);

    setCommandControlsEnabled(true);

    byId('apiStatus').textContent = `TVS embed API version ${message.version} ready; channel access: ${message.capabilities?.channelInfo || 'none'}.`;
    byId('embedStatus').textContent = 'TVS is loaded and ready. Send a command using the controls below.';

    delete byId('embedStatus').dataset.state;

    return;
  }

  if (['TVS.Channels', 'TVS.Listings', 'TVS.UpNext', 'TVS.CurrentChannel', 'TVS.Volume', 'TVS.Muting', 'TVS.Power'].includes(message.type)) {
    byId('apiResult').textContent = JSON.stringify(message, null, 2);
    byId('apiStatus').textContent = `Received ${message.type}${message.requestId ? ` for ${message.requestId}` : ''}.`;
  }
}

/** Throttle live picture updates without dropping the last slider value. */
function createThrottledPictureSender() {
  let pending = {};
  let timer;
  let lastSentAt = -Infinity;

  function flush() {
    timer = undefined;

    if (!Object.keys(pending).length) {
      return;
    }

    const data = pending;

    pending = {};
    lastSentAt = performance.now();
    send('picture-settings', data);
  }

  return (data) => {
    Object.assign(pending, data);

    if (timer === undefined) {
      timer = setTimeout(flush, Math.max(0, 10 - (performance.now() - lastSentAt)));
    }
  };
}

const streamPictureSettings = createThrottledPictureSender();

/** Keep a displayed slider value and its partial picture-settings events in sync. */
function connectPictureSlider(inputId, outputId, property, fractionDigits) {
  const input = byId(inputId);
  const output = byId(outputId);

  output.value = Number(input.value).toFixed(fractionDigits);

  input.addEventListener('input', () => {
    const value = Number(input.value);
    output.value = value.toFixed(fractionDigits);
    streamPictureSettings({ [property]: value });
  });
}

/** Repeat volume, channel, and scale presses every 500 ms while held. */
function connectRepeatingRemoteButtons() {
  const repeatTimers = new Map();

  const stop = (button) => {
    const timer = repeatTimers.get(button);

    if (timer === undefined) {
      return;
    }

    clearInterval(timer);
    repeatTimers.delete(button);
  };

  document.querySelectorAll('[data-repeat-remote-command]').forEach((button) => {
    const sendCommand = () => send('remote', { command: button.dataset.repeatRemoteCommand });

    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || repeatTimers.has(button)) {
        return;
      }

      event.preventDefault();
      button.setPointerCapture?.(event.pointerId);

      sendCommand();
      repeatTimers.set(button, setInterval(sendCommand, 500));
    });

    button.addEventListener('pointerup', () => stop(button));
    button.addEventListener('pointercancel', () => stop(button));
    button.addEventListener('lostpointercapture', () => stop(button));

    button.addEventListener('click', (event) => {
      if (event.detail === 0) {
        sendCommand();
      }
    });
  });

  window.addEventListener('blur', () => [...repeatTimers.keys()].forEach(stop));
}

/** Pick the single global slot or one numbered channel's slot. */
function overlayAddress() {
  if (document.querySelector('[name="overlayTarget"]:checked').value === 'all') {
    return { channelNumber: '*' };
  }

  return {
    channelNumber: byId('overlayChannel').value.trim(),
    slotNumber: Number(byId('overlaySlot').value)
  };
}

/** Match the visible target controls and clear action to the chosen address. */
function updateOverlayTargetControls() {
  const allChannels = overlayAddress().channelNumber === '*';

  byId('individualOverlayFields').hidden = allChannels;
  byId('clearSelectedSlotButton').hidden = allChannels;
  byId('clearSelectedChannelButton').textContent = allChannels
    ? 'Clear all-channels slot' : 'Clear selected channel';
}

function selectedOverlayLayoutSource() {
  return document.querySelector('[name="overlayLayoutSource"]:checked').value;
}

/** Show the file picker and disable invalid custom-layout sends. */
function updateOverlayLayoutControls() {
  const customSelected = selectedOverlayLayoutSource() === 'custom';

  byId('weatherOverlayFields').hidden = customSelected;
  byId('customOverlayFields').hidden = !customSelected;
  byId('sendOverlayButton').disabled = customSelected && !customOverlayLayout;
  byId('updateOverlayButton').disabled = customSelected && !customOverlayLayout;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Check the minimum Character Generator structure before accepting a file. */
function assertDisplayableLayoutPage(page, label) {
  if (!isPlainObject(page) || typeof page.id !== 'string' || typeof page.memo !== 'string' || !Array.isArray(page.lines)) {
    throw new Error(`${label} is missing its displayable structure.`);
  }

  page.lines.forEach((line, index) => {
    if (!isPlainObject(line) || typeof line.id !== 'string' || !Array.isArray(line.chunks)) {
      throw new Error(`${label} line ${index + 1} is missing its displayable content.`);
    }

    line.chunks.forEach((chunk) => {
      if (!isPlainObject(chunk) || typeof chunk.id !== 'string' || typeof chunk.text !== 'string') {
        throw new Error(`${label} line ${index + 1} contains an invalid chunk.`);
      }
    });
  });
}

function assertDisplayableLayout(layout) {
  if (!isPlainObject(layout) || typeof layout.version !== 'number' || !isPlainObject(layout.layout)) {
    throw new Error('Layout JSON must contain a version and layout settings.');
  }

  const body = layout.layout.body;

  if (typeof layout.layout.showHeader !== 'boolean' || typeof layout.layout.showFooter !== 'boolean'
    || !isPlainObject(body) || typeof body.backgroundColor !== 'string' || typeof body.textColor !== 'string') {
    throw new Error('Layout settings are malformed or cannot be displayed.');
  }

  assertDisplayableLayoutPage(layout.header, 'Layout header');
  assertDisplayableLayoutPage(layout.footer, 'Layout footer');

  if (!Array.isArray(layout.pages)) {
    throw new Error('Layout JSON is missing its pages array.');
  }

  layout.pages.forEach((page, index) => assertDisplayableLayoutPage(page, `Layout page ${index + 1}`));
}

/** Discover variables referenced by the layout or declared in variableDefinitions. */
function collectCustomOverlayVariables(layout) {
  const variables = new Map();

  const addVariable = (rawKey, source = {}) => {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';

    if (!key || (!CUSTOM_VARIABLE_KEY_PATTERN.test(key) && !key.startsWith('system.'))) {
      return;
    }
    
    const current = variables.get(key) || { key, isImage: false, placeholder: '' };
    current.isImage ||= source.chunkType === 'image';
    current.placeholder ||= typeof source.editorPlaceholderText === 'string' ? source.editorPlaceholderText : '';

    variables.set(key, current);
  };

  const visit = (value) => {
    if (Array.isArray(value)) {
      return value.forEach(visit);
    }

    if (!isPlainObject(value)) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(value, 'variableKey')) {
      addVariable(value.variableKey, value);
    }

    Object.values(value).forEach(visit);
  };

  visit(layout.header);
  visit(layout.footer);
  visit(layout.pages);

  const definitions = isPlainObject(layout.variableDefinitions) ? layout.variableDefinitions : {};

  for (const [key, definition] of Object.entries(definitions)) {
    addVariable(key);

    const variable = variables.get(key);

    if (variable && isPlainObject(definition)) {
      variable.definition = definition;
    }
  }

  return [...variables.values()];
}

/** Build an input appropriate to each discovered string, boolean, or date variable. */
function createCustomVariableControl(variable) {
  const definition = variable.definition || {};
  const type = definition.type === 'date' || definition.type === 'boolean' ? definition.type : 'string';
  const label = document.createElement('label');
  const heading = document.createElement('span');

  heading.textContent = `${variable.key} (${type === 'string' ? (variable.isImage ? 'image URL' : 'text') : type})`;
  label.append(heading);

  let control;

  if (type === 'boolean') {
    control = document.createElement('select');
    const falseValues = isPlainObject(definition.boolean) && Array.isArray(definition.boolean.falseValues)
      ? definition.boolean.falseValues : [];
    const falseValue = falseValues.find((value) => typeof value === 'string' && value.trim()) || 'false';

    control.append(new Option('(unset)', ''), new Option('True', 'true'), new Option('False', falseValue));
  } else {
    control = document.createElement('input');

    const inputMode = isPlainObject(definition.date) ? definition.date.inputMode : undefined;
    const formattedDate = type === 'date' && inputMode === 'custom';

    control.type = type === 'date' && !formattedDate ? 'datetime-local' : 'text';

    if (control.type === 'datetime-local') {
      control.step = '1';
    }

    if (formattedDate && typeof definition.date.inputFormat === 'string') {
      control.placeholder = `Expected format: ${definition.date.inputFormat}`;
    } else if (variable.placeholder) {
      control.placeholder = variable.placeholder;
    }

    if (type === 'date') {
      control.dataset.dateInputMode = inputMode || 'iso-8601';
    }
  }

  control.dataset.overlayVariableKey = variable.key;
  label.append(control);

  return label;
}

function renderCustomOverlayVariables(layout) {
  const variables = collectCustomOverlayVariables(layout);
  const editable = variables.filter((variable) => !variable.key.startsWith('system.'));
  const system = variables.filter((variable) => variable.key.startsWith('system.'));
  const container = byId('customOverlayVariableFields');

  container.replaceChildren();
  editable.forEach((variable) => container.append(createCustomVariableControl(variable)));

  if (!editable.length) {
    const empty = document.createElement('p');

    empty.className = 'hint';
    empty.textContent = 'This layout does not declare any editable variables.';
    container.append(empty);
  }

  const systemMessage = byId('customOverlaySystemVariables');

  systemMessage.hidden = system.length === 0;
  systemMessage.textContent = system.length
    ? `TVS supplies these system variables automatically: ${system.map((variable) => variable.key).join(', ')}` : '';
  
  return { editableCount: editable.length, systemCount: system.length };
}

/** Parse the selected file locally; its layout is sent directly to the iframe. */
async function loadCustomOverlayLayout(event) {
  const file = event.target.files[0];

  customOverlayLayout = undefined;

  byId('customOverlayVariableFields').replaceChildren();
  byId('customOverlaySystemVariables').hidden = true;

  updateOverlayLayoutControls();

  const status = byId('customOverlayLayoutStatus');

  if (!file) {
    status.textContent = 'Choose a character-generator layout exported as JSON.';
    return;
  }

  if (file.size > MAX_CUSTOM_LAYOUT_BYTES) {
    status.textContent = 'That layout is larger than the 10 MB demo limit.';
    return;
  }

  try {
    const layout = JSON.parse(await file.text());
    assertDisplayableLayout(layout);
    customOverlayLayout = layout;

    const { editableCount, systemCount } = renderCustomOverlayVariables(layout);
    status.textContent = `${file.name} loaded. Detected ${editableCount + systemCount} variables (${editableCount} editable).`;
  } catch (error) {
    status.textContent = `Could not load ${file.name}: ${error.message}`;
  }

  updateOverlayLayoutControls();
}

/** Convert date inputs to the representation requested by the layout. */
function customOverlayVariableValue(control) {
  const value = control.value;
  const inputMode = control.dataset.dateInputMode;

  if (!value || !inputMode || inputMode === 'custom') {
    return value;
  }

  const milliseconds = new Date(value).getTime();

  if (!Number.isFinite(milliseconds)) {
    return value;
  }

  if (inputMode === 'unix-ms') {
    return String(milliseconds);
  }

  if (inputMode === 'unix-seconds') {
    return String(Math.floor(milliseconds / 1000));
  }

  return new Date(milliseconds).toISOString();
}

function overlayData() {
  if (selectedOverlayLayoutSource() === 'custom') {
    const variables = {};

    document.querySelectorAll('[data-overlay-variable-key]').forEach((control) => {
      const value = customOverlayVariableValue(control);

      if (value !== '') {
        variables[control.dataset.overlayVariableKey] = value;
      }
    });

    return { variables };
  }

  return { variables: { alert: byId('overlayAlert').value, area: `${location.origin}/area.png` } };
}

/** Reuse the bundled weather layout or the file chosen by the user. */
async function selectedOverlayLayout() {
  if (selectedOverlayLayoutSource() === 'custom') {
    if (!customOverlayLayout) {
      throw new Error('Choose a valid custom layout JSON file first.');
    }

    return customOverlayLayout;
  }

  weatherOverlayLayoutPromise ||= fetch('weather.json').then((response) => {
    if (!response.ok) {
      throw new Error(`Could not load the weather layout (${response.status}).`);
    }

    return response.json();
  });

  return weatherOverlayLayoutPromise;
}

function overlayExpiration() {
  const minutes = Number(byId('overlayMinutes').value);

  if (!Number.isFinite(minutes) || minutes < 1) {
    throw new Error('Expiration must be at least one minute.');
  }

  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/** A complete overlay replaces one addressed slot. */
async function sendOverlay() {
  try {
    const layout = await selectedOverlayLayout();
    const audioUrl = byId('overlayAudio').value.trim();
    const data = {
      ...overlayAddress(), layout, data: overlayData(),
      expiresAt: overlayExpiration(), mixBlendMode: byId('overlayBlendMode').value
    };

    if (audioUrl) {
      data.audio = { src: audioUrl, behavior: byId('overlayBehavior').value };
    }

    send('overlay', data);
  } catch (error) {
    byId('embedStatus').textContent = `Could not send overlay: ${error.message}`;
  }
}

/** Replace only dynamic data and expiration; the layout remains unchanged. */
function updateOverlay() {
  try {
    if (selectedOverlayLayoutSource() === 'custom' && !customOverlayLayout) {
      throw new Error('Choose a valid custom layout JSON file first.');
    }
    
    send('overlay-data-update', {
      ...overlayAddress(), data: overlayData(), expiresAt: overlayExpiration()
    });
  } catch (error) {
    byId('embedStatus').textContent = `Could not update overlay: ${error.message}`;
  }
}

/** Clear one slot, an entire channel, the global slot, or every slot. */
function clearOverlay(scope) {
  const address = overlayAddress();
  const data = scope === 'all' ? {}
    : scope === 'channel' ? { channelNumber: address.channelNumber }
    : address;

  send('overlay-clear', data);
}

frame.addEventListener('load', () => {
  frameLoaded = true;
  apiReady = false;
  
  setCommandControlsEnabled(false);
  byId('embedStatus').textContent = '';
  delete byId('embedStatus').dataset.state;

  const hello = () => postToTv({ type: 'TVS.EmbedHello' }, false);

  hello();
  clearInterval(helloInterval);
  helloInterval = setInterval(hello, 1_000);
  clearTimeout(readyTimeout);

  readyTimeout = setTimeout(() => {
    if (apiReady) {
      return;
    }

    byId('embedStatus').textContent = `TVS did not respond. Configure remote management as embed mode with parentOrigin: ${location.origin}`;
    byId('embedStatus').dataset.state = 'warning';
  }, 1_500);
});

window.addEventListener('message', handleTvMessage);

byId('load').addEventListener('click', loadTv);

byId('setChannel').addEventListener('click', () => send('channel-change', {
  channelNumber: byId('channelNumber').value.trim(), hideOsd: byId('hideOsd').checked
}));

byId('setReceiverSettings').addEventListener('click', () => send('receiver-settings', {
  volume: Number(byId('volume').value), isMuting: byId('isMuting').checked
}));

byId('setPicture').addEventListener('click', () => send('picture-settings', {
  noise: Number(byId('noise').value), blur: Number(byId('blur').value),
  scanlines: byId('scanlines').checked, changeChannelNoise: byId('changeChannelNoise').checked
}));

byId('clearPicture').addEventListener('click', () => send('picture-settings', {
  noise: null, blur: null, scanlines: null, changeChannelNoise: null
}));

document.querySelectorAll('[data-command]').forEach((button) => {
  button.addEventListener('click', () => send('remote', { command: button.dataset.command }));
});

document.querySelectorAll('[name="overlayTarget"]').forEach((input) => {
  input.addEventListener('change', updateOverlayTargetControls);
});

document.querySelectorAll('[name="overlayLayoutSource"]').forEach((input) => {
  input.addEventListener('change', updateOverlayLayoutControls);
});

byId('customOverlayLayoutFile').addEventListener('change', loadCustomOverlayLayout);
byId('sendOverlayButton').addEventListener('click', sendOverlay);
byId('updateOverlayButton').addEventListener('click', updateOverlay);
byId('clearSelectedSlotButton').addEventListener('click', () => clearOverlay('slot'));
byId('clearSelectedChannelButton').addEventListener('click', () => clearOverlay('channel'));
byId('clearEverySlotButton').addEventListener('click', () => clearOverlay('all'));
byId('getChannels').addEventListener('click', () => apiRequest('TVS.GetChannels'));
byId('getListings').addEventListener('click', () => apiRequest('TVS.GetListings', {
  startTime: new Date().toISOString(),
  endTime: new Date(Date.now() + 90 * 60_000).toISOString()
}));

byId('getUpNext').addEventListener('click', () => apiRequest('TVS.GetUpNext', {
  numberOfPrograms: 3,
  includeCurrentProgram: true
}));

connectPictureSlider('noise', 'noiseValue', 'noise', 2);
connectPictureSlider('blur', 'blurValue', 'blur', 1);
connectRepeatingRemoteButtons();
updateOverlayTargetControls();
updateOverlayLayoutControls();
loadTv();