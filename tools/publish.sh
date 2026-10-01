#!/bin/sh
# Test, build and publish dist/ to the gh-pages branch → https://andy555-cmyk.github.io/duri-couple/
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
npm test --silent
npm run build
OUT=$(mktemp -d)
cp -R dist/. "$OUT/"
touch "$OUT/.nojekyll"
cd "$OUT"
git init -q -b gh-pages
git add -A
git -c user.name="andy555-cmyk" -c user.email="ganpan0@gmail.com" commit -q -m "Deploy $(date +%Y-%m-%d_%H%M) from $(git -C "$ROOT" rev-parse --short HEAD)"
GIT_SSH_COMMAND="ssh -o IdentitiesOnly=yes -i $HOME/.ssh/id_ed25519_hayday" git push -q -f git@github.com:andy555-cmyk/duri-couple.git gh-pages
cd "$ROOT"
rm -rf "$OUT"
echo "deployed: https://andy555-cmyk.github.io/duri-couple/"
