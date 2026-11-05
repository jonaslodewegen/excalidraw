#!/bin/sh
#
# Runs on the droplet as the non-root `deploy` user, installed root-owned as
# /usr/local/bin/excalidraw-deploy so that user can't change it. It's started by
# the GitHub Action over SSH, through a key that can only run this script.
#
# Publishes the latest build from the deploy branch to the web folder. The git
# data lives outside that folder, as a .git folder there would be publicly
# downloadable. Files the build doesn't track, such as .htaccess, are left alone.

set -eu

# Apache reads these files as another user
umask 022

GIT_DIR=/opt/excalidraw-deploy.git
WEB_ROOT=/var/www/draw
LOCK_FILE=/run/lock/excalidraw-deploy.lock

# Only one deploy at a time. flock is released when this script exits.
exec 9>"$LOCK_FILE"
flock 9

git_deploy() {
  git --git-dir="$GIT_DIR" --work-tree="$WEB_ROOT" "$@"
}

git_deploy fetch --quiet origin +deploy:refs/remotes/origin/deploy
git_deploy checkout --quiet --force --detach origin/deploy

echo "Deployed: $(git_deploy log -1 --format=%s)"
