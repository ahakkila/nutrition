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

function calculate({ persist = true } = {}) {
  const weight = Number.parseFloat(weightInput.value);
  const valid = Number.isFinite(weight) && weight >= 1 && weight <= 500;
  errorMessage.hidden = valid;
  weightInput.setAttribute('aria-invalid', String(!valid));
  if (!valid) return;
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
  const weight = Number.parseFloat(savedWeight);
  if (savedWeight !== null && Number.isFinite(weight) && weight >= 1 && weight <= 500) {
    weightInput.value = savedWeight;
    calculate({ persist: false });
  }
} catch {
  // Storage can be unavailable in private browsing or restricted contexts.
}

let loadedRevision;
const revisionCheckInterval = 5 * 60 * 1000;

function showUpdateToast() {
  updateToast.hidden = false;
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
    if (!loadedRevision) appVersion.textContent = 'v0.3.0';
  }
}

checkForUpdates();
window.setInterval(checkForUpdates, revisionCheckInterval);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkForUpdates();
});
