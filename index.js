async function api(endpoint, token) {
    const response = await fetch(`https://api.github.com/repos/${endpoint}`, {
        headers: token ? {
            Authorization: `Bearer ${token}`
        } : undefined
    });
    return response.json();
}

// Great for downloads with many sub directories
// Pros: one request + maybe doesn't require token
// Cons: huge on huge repos + may be truncated
async function viaTreesApi({
    user,
    repository,
    ref = 'HEAD',
    directory,
    token,
    getFullData = false
}) {
    if (!directory.endsWith('/')) {
        directory += '/';
    }

    const files = [];
    const contents = await api(`${user}/${repository}/git/trees/${ref}?recursive=1`, token);
    if (contents.message) {
        throw new Error(contents.message);
    }

    for (const item of contents.tree) {
        if (item.type === 'blob' && item.path.startsWith(directory)) {
            files.push(getFullData ? item : item.path);
        }
    }

    files.truncated = contents.truncated;
    return files;
}

var planned = null

function save (blob, filename) {
    if (planned) {
        return planned.then(function () {
            planned = save(data, filename)
            return planned
        })
    }
    else {
        planned = new Promise(function (ok, nok) {

            saveAs(blob, filename)

            //prompt next dialog only when window got focus back
            window.addEventListener('focus', function resolve() {
                planned = null
                window.removeEventListener('focus', resolve)
                ok()
            })
        })

        return planned
    }
}

// Matches '/<re/po>/tree/<ref>/<dir>'
const urlParserRegex = /^[/]([^/]+)[/]([^/]+)[/]tree[/]([^/]+)[/](.*)/;

function updateStatus(status, ...extra) {
    const element = document.querySelector('.status');
    element.innerHTML = status || '';
    console.log(element.textContent, ...extra);
}

async function fetchRepoInfo(repo) {
    const response = await fetch(`https://api.github.com/repos/${repo}`);

    switch (response.status) {
        case 401:
            updateStatus('⚠ The token provided is invalid or has been revoked.', {token: localStorage.token});
            throw new Error('Invalid token');

        case 403:
            // See https://developer.github.com/v3/#rate-limiting
            if (response.headers.get('X-RateLimit-Remaining') === '0') {
                updateStatus('⚠ Your token rate limit has been exceeded.', {token: localStorage.token});
                throw new Error('Rate limit exceeded');
            }

            break;

        case 404:
            updateStatus('⚠ Repository was not found.', {repo});
            throw new Error('Repository not found');

        default:
    }

    if (!response.ok) {
        updateStatus('⚠ Could not obtain repository data from the GitHub API.', {repo, response});
        throw new Error('Fetch error');
    }

    return response.json();
}

async function getZIP() {
    const {default: JSZip} = await import(new URL('https://cdn.skypack.dev/jszip@^3.4.0'));
    return new JSZip();
}

async function init() {
    const zip = getZIP();
    let user;
    let repository;
    let ref;
    let dir;

    try {
        const query = new URLSearchParams(location.search);
        const parsedUrl = new URL(query.get('url'));
        [, user, repository, ref, dir] = urlParserRegex.exec(parsedUrl.pathname);

        console.log('Source:', {user, repository, ref, dir});
    } catch {
        return updateStatus();
    }

    if (!navigator.onLine) {
        updateStatus('⚠ You are offline.');
        throw new Error('You are offline');
    }

    updateStatus('Retrieving directory info…');

    const {private: repoIsPrivate} = await fetchRepoInfo(`${user}/${repository}`);

    const files = await viaTreesApi({
        user,
        repository,
        ref,
        directory: decodeURIComponent(dir),
        token: localStorage.token,
        getFullData: true,
    });

    if (files.length === 0) {
        updateStatus('No files to download');
        return;
    }

    updateStatus(`Downloading (0/${files.length}) files…`, '\n• ' + files.map(file => file.path).join('\n• '));

    const controller = new AbortController();

    const fetchPublicFile = async file => {
        const response = await fetch(`https://raw.githubusercontent.com/${user}/${repository}/${ref}/${file.path}`, {
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.statusText} for ${file.path}`);
        }

        return response.blob();
    };

    let downloaded = 0;

    const download = async file => {
        const blob = await fetchPublicFile(file);

        downloaded++;
        updateStatus(`Downloading (${downloaded}/${files.length}) files…`, file.path);

        (await zip).file(file.path, blob, {
            binary: true,
        });
    };

    try {
        await Promise.all(files.map(file => download(file)));
    } catch (error) {
        controller.abort();

        if (!navigator.onLine) {
            updateStatus('⚠ Could not download all files, network connection lost.');
        } else if (error.message.startsWith('HTTP ')) {
            updateStatus('⚠ Could not download all files.');
        } else {
            updateStatus('⚠ Some files were blocked from downloading, try to disable any ad blockers and refresh the page.');
        }

        throw error;
    }

    updateStatus(`Zipping ${downloaded} files…`);

    const zipBlob = await (await zip).generateAsync({
        type: 'blob',
    });

    await save(zipBlob, `${user} ${repository} ${ref} ${dir}.zip`.replace(/\//, '-'));
    updateStatus(`Downloaded ${downloaded} files! Done!`);
}

init();