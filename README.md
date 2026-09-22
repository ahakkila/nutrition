# Rooted

A tiny, dependency-free nutrition calculator. Enter a weight in kilograms to see a simple daily baseline for calories, protein, fat, carbohydrates, and water.

## Run locally

Open `index.html` in a browser. No installation or build step is required.

## Publish with GitHub Pages

1. Create an empty repository on GitHub.
2. Run `git init`, add the files, commit, and push to the repository.
3. In the repository, open **Settings → Pages**.
4. Select **Deploy from a branch**, choose `main` and `/ (root)`, then save.

The site is static, so GitHub Pages can serve it directly.

The current app version is shown in the footer as a semantic version and `YYYYMMDDhhmmss` build timestamp. Bump the version when a meaningful feature or behavior change is released; update the timestamp for each deployed build.

To create a timestamped revision, run the helper before committing:

```bash
node revision.js
git add .
git commit -m "Update app"
git push
```

The current revision can be checked directly in `version.json`.

## Install on a phone

After GitHub Pages is enabled, open the site on your phone over its `https://` URL. On iPhone, use **Share → Add to Home Screen**. On Android, use the browser menu and choose **Install app** or **Add to Home screen**. The app includes offline support after the first visit.
