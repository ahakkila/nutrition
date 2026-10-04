const weightInput = document.querySelector('#weight');
const nutritionForm = document.querySelector('#nutrition-form');
const errorMessage = document.querySelector('#error');
const appVersion = document.querySelector('#app-version');
const updateToast = document.querySelector('#update-toast');
const updateButton = document.querySelector('#update-button');
const performanceNotes = document.querySelector('#performance-notes');
const profileInputs = document.querySelectorAll('input[name="profile"]');
const minimumWeight = 30;
const maximumWeight = 250;

const profiles = {
  balanced: { label: 'Balanced', calories: 22, protein: 1.4, fat: 0.75 },
  performance: { label: 'Performance', calories: 26, protein: 1.8, fat: 0.8 },
};

const values = {
  calories: document.querySelector('#calories'),
  protein: document.querySelector('#protein'),
  fat: document.querySelector('#fat'),
  carbs: document.querySelector('#carbs'),
  water: document.querySelector('#water'),
  weight: document.querySelector('#results-weight'),
  title: document.querySelector('#results-title'),
};

function getValidWeight(value) {
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const weight = Number(value);
  return weight >= minimumWeight && weight <= maximumWeight ? weight : null;
}

function validateWeight(value) {
  const weight = getValidWeight(value);
  return {
    weight,
    valid: weight !== null,
    message: weight === null ? getWeightError(value) : '',
  };
}

function getWeightError(value) {
  if (value.trim() === '') {
    return 'Enter a whole-number weight between 30 and 250 kg, without leading zeros.';
  }
  const numericValue = Number(value);
  if (/[.,]/.test(value)) {
    return 'Decimal weights are not supported. Enter a whole-number weight between 30 and 250 kg.';
  }
  if (/^0[0-9]/.test(value)) {
    return 'Leading zeros are not supported. Enter a whole-number weight between 30 and 250 kg.';
  }
  if (Number.isFinite(numericValue) && numericValue < minimumWeight) {
    return 'Weights below 30 kg are outside this calculator’s range. Children should use this only with parental and expert guidance.';
  }
  if (Number.isFinite(numericValue) && numericValue > maximumWeight) {
    return 'Weights above 250 kg are outside this calculator’s range. Please consult a healthcare professional for individualized guidance.';
  }
  return 'Enter a whole-number weight between 30 and 250 kg, without leading zeros.';
}

function clearResults() {
  values.calories.textContent = '—';
  values.protein.textContent = '—';
  values.fat.textContent = '—';
  values.carbs.textContent = '—';
  values.water.textContent = '—';
  values.weight.textContent = '— kg';
  values.title.textContent = 'A good place to begin';
}

function calculate({ persist = true, recordHistory = true } = {}) {
  const validation = validateWeight(weightInput.value);
  const { weight, valid } = validation;
  errorMessage.textContent = validation.message;
  errorMessage.hidden = valid;
  weightInput.setAttribute('aria-invalid', String(!valid));
  if (!valid) {
    clearResults();
    return;
  }
  if (persist) weightInput.blur();
  const profileKey = document.querySelector('input[name="profile"]:checked').value;
  const profile = profiles[profileKey];
  performanceNotes.hidden = profileKey !== 'performance';

  if (persist) {
    window.RootedStorage.save(weight, profileKey, { recordHistory });
  }

  const calories = weight * profile.calories;
  const protein = weight * profile.protein;
  const fat = weight * profile.fat;
  const carbs = (calories - (4 * protein) - (9 * fat)) / 4;
  values.calories.textContent = Math.round(calories).toLocaleString();
  values.protein.textContent = Math.round(protein);
  values.fat.textContent = Math.round(fat);
  values.carbs.textContent = Math.round(carbs);
  values.water.textContent = ((weight * 30) / 1000).toFixed(1);
  values.weight.textContent = `${weight.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
  values.title.textContent = `${profile.label} guide at ${weight.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
}

nutritionForm.addEventListener('submit', (event) => {
  event.preventDefault();
  calculate();
});

weightInput.addEventListener('input', () => {
  if (getValidWeight(weightInput.value) === null) clearResults();
  errorMessage.hidden = true;
  weightInput.setAttribute('aria-invalid', 'false');
});

weightInput.addEventListener('blur', () => calculate());

profileInputs.forEach((profileInput) => {
  profileInput.addEventListener('change', () => {
    performanceNotes.hidden = profileInput.value !== 'performance';
    if (weightInput.value) {
      calculate({ recordHistory: false });
      return;
    }

    window.RootedStorage.save(null, profileInput.value, { recordHistory: false });
  });
});

updateButton.addEventListener('click', () => window.location.reload());

const historyList = document.querySelector('#weight-history-list');
const historyToggle = document.querySelector('#history-toggle');
const historyEmpty = document.querySelector('#history-empty');
let weightHistory = {};
let showAllHistory = false;
function renderHistory(history) {
  weightHistory = history;
  const dates = Object.keys(history).sort().reverse();
  historyList.replaceChildren();
  historyEmpty.hidden = dates.length > 0;
  historyToggle.hidden = dates.length <= 30;
  historyToggle.textContent = showAllHistory ? 'Show last 30' : 'Show all';
  historyToggle.setAttribute('aria-expanded', String(showAllHistory));
  for (const date of showAllHistory ? dates : dates.slice(0, 30)) {
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = date;
    // Noon local time avoids UTC shifting a calendar date on display.
    time.textContent = new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
    const weight = document.createElement('span');
    weight.textContent = `${history[date].weight} kg`;
    item.append(time, weight);
    historyList.append(item);
  }
}
historyToggle.addEventListener('click', () => {
  showAllHistory = !showAllHistory;
  renderHistory(weightHistory);
});
const disconnectButton = document.querySelector('#disconnect-sync');
disconnectButton.addEventListener('click', () => window.RootedStorage.disconnect());
window.RootedStorage.init({
  profiles,
  onData({ settings, history }) {
    if (settings) {
      document.querySelector(`input[name="profile"][value="${settings.profile}"]`).checked = true;
      performanceNotes.hidden = settings.profile !== 'performance';
      weightInput.value = settings.weight === null ? '' : String(settings.weight);
      if (settings.weight !== null) calculate({ persist: false });
      else {
        clearResults();
        errorMessage.hidden = true;
        weightInput.setAttribute('aria-invalid', 'false');
      }
    }
    renderHistory(history);
  },
  onHistory: renderHistory,
  onStatus({ connected, message, lastSynced, storageWarning }) {
    document.querySelector('#sync-status').textContent = message;
    disconnectButton.hidden = !connected;
    const lastSync = document.querySelector('#last-synced');
    lastSync.hidden = !connected || !lastSynced;
    lastSync.textContent = lastSynced ? `Last synced ${new Date(lastSynced).toLocaleString()}` : '';
    const warning = document.querySelector('#storage-warning');
    warning.hidden = !storageWarning;
    warning.textContent = storageWarning || '';
  },
});

let loadedRevision;
let pendingUpdate;
const revisionCheckInterval = 5 * 60 * 1000;

function showUpdateToast() {
  if (document.hidden) {
    pendingUpdate = true;
    return;
  }
  updateToast.hidden = false;
}

if ('serviceWorker' in navigator) {
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) showUpdateToast();
    hadController = true;
  });
}

async function checkForUpdates() {
  try {
    const response = await fetch(`./version.json?check=${Date.now()}`, { cache: 'no-store' });
    const revision = await response.json();
    const revisionKey = `${revision.version}:${revision.timestamp}`;

    if (loadedRevision && revisionKey !== loadedRevision) {
      if (!document.hidden) showUpdateToast();
      return;
    }

    loadedRevision = revisionKey;
    appVersion.textContent = `v${revision.version} · ${revision.timestamp}`;
  } catch {
    if (!loadedRevision) appVersion.textContent = 'v0.5.0';
  }
}

checkForUpdates();
window.setInterval(checkForUpdates, revisionCheckInterval);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (pendingUpdate) {
      pendingUpdate = false;
      showUpdateToast();
    }
    checkForUpdates();
    window.RootedStorage.sync();
  }
});
