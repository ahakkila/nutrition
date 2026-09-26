const weightInput = document.querySelector('#weight');
const nutritionForm = document.querySelector('#nutrition-form');
const errorMessage = document.querySelector('#error');
const appVersion = document.querySelector('#app-version');
const updateToast = document.querySelector('#update-toast');
const updateButton = document.querySelector('#update-button');
const performanceNotes = document.querySelector('#performance-notes');
const weightStorageKey = 'rooted-weight';
const profileStorageKey = 'rooted-profile';
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

function calculate({ persist = true } = {}) {
  const weight = getValidWeight(weightInput.value);
  const valid = weight !== null;
  errorMessage.textContent = valid ? '' : getWeightError(weightInput.value);
  errorMessage.hidden = valid;
  weightInput.setAttribute('aria-invalid', String(!valid));
  if (!valid) {
    clearResults();
    return;
  }
  weightInput.blur();
  const profileKey = document.querySelector('input[name="profile"]:checked').value;
  const profile = profiles[profileKey];
  performanceNotes.hidden = profileKey !== 'performance';

  if (persist) {
    try {
      window.localStorage.setItem(weightStorageKey, weightInput.value);
      window.localStorage.setItem(profileStorageKey, profileKey);
    } catch {
      // Storage can be unavailable in private browsing or restricted contexts.
    }
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

weightInput.addEventListener('blur', calculate);

profileInputs.forEach((profileInput) => {
  profileInput.addEventListener('change', () => {
    performanceNotes.hidden = profileInput.value !== 'performance';
    if (weightInput.value) {
      calculate();
      return;
    }

    try {
      window.localStorage.setItem(profileStorageKey, profileInput.value);
    } catch {
      // Storage can be unavailable in private browsing or restricted contexts.
    }
  });
});

updateButton.addEventListener('click', () => window.location.reload());

try {
  const savedProfile = window.localStorage.getItem(profileStorageKey);
  if (savedProfile && profiles[savedProfile]) {
    document.querySelector(`input[name="profile"][value="${savedProfile}"]`).checked = true;
    performanceNotes.hidden = savedProfile !== 'performance';
  }

  const savedWeight = window.localStorage.getItem(weightStorageKey);
  if (savedWeight !== null && getValidWeight(savedWeight) !== null) {
    weightInput.value = savedWeight;
    calculate({ persist: false });
  }
} catch {
  // Storage can be unavailable in private browsing or restricted contexts.
}

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
    if (!loadedRevision) appVersion.textContent = 'v0.3.6';
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
  }
});
