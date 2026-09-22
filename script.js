const weightInput = document.querySelector('#weight');
const nutritionForm = document.querySelector('#nutrition-form');
const errorMessage = document.querySelector('#error');
const appVersion = document.querySelector('#app-version');

const values = {
  calories: document.querySelector('#calories'),
  protein: document.querySelector('#protein'),
  fat: document.querySelector('#fat'),
  carbs: document.querySelector('#carbs'),
  water: document.querySelector('#water'),
  weight: document.querySelector('#results-weight'),
  title: document.querySelector('#results-title'),
};

function calculate() {
  const weight = Number.parseFloat(weightInput.value);
  const valid = Number.isFinite(weight) && weight >= 1 && weight <= 500;
  errorMessage.hidden = valid;
  weightInput.setAttribute('aria-invalid', String(!valid));
  if (!valid) return;
  weightInput.blur();

  const calories = weight * 26;
  values.calories.textContent = Math.round(calories).toLocaleString();
  values.protein.textContent = Math.round(weight * 2);
  values.fat.textContent = Math.round(calories / 30);
  values.carbs.textContent = Math.round(weight * 2.55);
  values.water.textContent = (weight / 30).toFixed(1);
  values.weight.textContent = `${weight.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
  values.title.textContent = `Your guide at ${weight.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
}

nutritionForm.addEventListener('submit', (event) => {
  event.preventDefault();
  calculate();
});

let loadedRevision;
const revisionCheckInterval = 5 * 60 * 1000;

async function checkForUpdates() {
  try {
    const response = await fetch(`./version.json?check=${Date.now()}`, { cache: 'no-store' });
    const revision = await response.json();
    const revisionKey = `${revision.version}:${revision.timestamp}`;

    if (loadedRevision && revisionKey !== loadedRevision) {
      window.location.reload();
      return;
    }

    loadedRevision = revisionKey;
    appVersion.textContent = `v${revision.version} · ${revision.timestamp}`;
  } catch {
    if (!loadedRevision) appVersion.textContent = 'v0.1.0';
  }
}

checkForUpdates();
window.setInterval(checkForUpdates, revisionCheckInterval);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkForUpdates();
});
