// Background Removal, the page side: a "Remove background" item in a character's More… menu
// and a /bgremove slash command, both calling this repo's server plugin. Cutouts are saved
// to the character's gallery (SillyTavern's user images).

const PLUGIN_URL = '/api/plugins/background-removal';
const PLUGIN_REPO = 'https://github.com/pervertir/SillyTavern-BackgroundRemoval';
const MENU_OPTION_ID = 'bgremove_character';
const TITLE = 'Background Removal';

class PluginMissingError extends Error {}

let installHelpShown = false;

function context() {
    return SillyTavern.getContext();
}

/** How to install the server half, once per session. */
function showInstallHelp() {
    if (installHelpShown) {
        return;
    }
    installHelpShown = true;
    const { callGenericPopup, POPUP_TYPE } = context();
    callGenericPopup(`
        <h3>Background removal needs its server plugin</h3>
        <div class="justifyLeft">
            <p>Extensions can't run code on your machine, so the cutting is done by a SillyTavern
            server plugin from the same repo.</p>
            <ol>
                <li>Set <code>enableServerPlugins: true</code> in SillyTavern's <code>config.yaml</code>.</li>
                <li>In SillyTavern's <code>plugins</code> folder run<br>
                    <code>git clone ${PLUGIN_REPO}</code><br>
                    then <code>npm install</code> inside the new folder.</li>
                <li>Restart SillyTavern and reload this page.</li>
            </ol>
        </div>`, POPUP_TYPE.TEXT, '', { allowVerticalScrolling: true });
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]+,/, ''));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

/** Shows the model download progress while the first cutout waits on it. */
function watchProgress() {
    let toast = null;
    const timer = setInterval(async () => {
        try {
            const status = await fetch(`${PLUGIN_URL}/status`, { cache: 'no-store' }).then(r => r.json());
            if (status.status !== 'downloading') {
                return;
            }
            const percent = status.total ? Math.round(status.received / status.total * 100) : null;
            const text = `Downloading the background removal model (one time only)${percent === null ? '' : `: ${percent}%`}`;
            if (toast) {
                toast.find('.toast-message').text(text);
            } else {
                toast = toastr.info(text, TITLE, { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false });
            }
        } catch {
            // the progress is only for show
        }
    }, 1000);
    return () => {
        clearInterval(timer);
        if (toast) {
            toastr.clear(toast);
        }
    };
}

/**
 * Cuts an image out of its background and saves the cutout to the user images.
 * @param {string} src Image URL
 * @param {string} [folder] Gallery folder (a character's name) to save into
 * @returns {Promise<string>} Path of the saved PNG
 */
export async function removeBackground(src, folder) {
    const source = await fetch(src);
    if (!source.ok) {
        throw new Error(`Could not load ${src}`);
    }
    const image = await blobToBase64(await source.blob());
    const { getRequestHeaders } = context();
    const stopProgress = watchProgress();
    let data;
    try {
        const response = await fetch(`${PLUGIN_URL}/remove`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ image }),
        });
        if (response.status === 404) {
            throw new PluginMissingError('The Background Removal server plugin is not installed');
        }
        data = await response.json().catch(() => ({}));
        if (!response.ok || !data.image) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }
    } finally {
        stopProgress();
    }
    const name = (src.split('/').pop() || 'image').split('?')[0].replace(/\.[^.]+$/, '');
    const upload = await fetch('/api/images/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            image: data.image,
            format: 'png',
            filename: `${decodeURIComponent(name)}-cutout-${Date.now()}`,
            ...(folder ? { ch_name: folder } : {}),
        }),
    });
    const saved = await upload.json().catch(() => ({}));
    if (!upload.ok || !saved.path) {
        throw new Error(saved.error || 'The cutout could not be saved');
    }
    return saved.path;
}

/** Shows a finished cutout on a checkerboard, with a download link. */
function showCutout(path, name) {
    const { callGenericPopup, POPUP_TYPE } = context();
    const url = `/${path.replace(/^\/+/, '')}`;
    const html = `
        <h3>${$('<span>').text(name).html()}: background removed</h3>
        <div class="bgremove-preview"><img src="${encodeURI(url)}" alt=""></div>
        <div class="bgremove-actions">
            <a class="menu_button menu_button_icon" href="${encodeURI(url)}" download>
                <i class="fa-solid fa-download"></i><span>Download</span>
            </a>
        </div>
        <small>Saved to ${$('<span>').text(name).html()}'s gallery.</small>`;
    callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: false, allowVerticalScrolling: true });
}

function reportError(error) {
    if (error instanceof PluginMissingError) {
        showInstallHelp();
        return;
    }
    console.error(`[${TITLE}]`, error);
    toastr.error(String(error?.message ?? error), TITLE);
}

/** The open character's card image and name, or null in a group or with no character. */
function currentCharacter() {
    const { characters, characterId, groupId } = context();
    const character = groupId ? null : characters[characterId];
    if (!character?.avatar || character.avatar === 'none') {
        return null;
    }
    return { src: `characters/${encodeURIComponent(character.avatar)}`, name: character.name };
}

async function removeFromCurrentCharacter() {
    const character = currentCharacter();
    if (!character) {
        toastr.warning('Open a character first.', TITLE);
        return;
    }
    const busy = toastr.info(`Removing the background from ${character.name}…`, TITLE, { timeOut: 0, extendedTimeOut: 0 });
    try {
        const path = await removeBackground(character.src, character.name);
        showCutout(path, character.name);
    } catch (error) {
        reportError(error);
    } finally {
        toastr.clear(busy);
    }
}

function addMenuItem() {
    const select = document.getElementById('char-management-dropdown');
    if (!select || document.getElementById(MENU_OPTION_ID)) {
        return;
    }
    const option = document.createElement('option');
    option.id = MENU_OPTION_ID;
    option.textContent = 'Remove background';
    select.append(option);
    const { eventSource, eventTypes } = context();
    eventSource.on(eventTypes.CHARACTER_MANAGEMENT_DROPDOWN, (target) => {
        if (target === MENU_OPTION_ID) {
            removeFromCurrentCharacter();
        }
    });
}

function addSlashCommand() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = context();
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bgremove',
        aliases: ['removebg'],
        returns: 'the path of the saved cutout',
        helpString: 'Removes the background from an image (the open character\'s card if none is given), saves the cutout to the gallery and returns its path. Needs the Background Removal server plugin.',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'show',
                description: 'show the cutout in a popup',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: ['true', 'false'],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'image URL',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        callback: async (args, url) => {
            const character = currentCharacter();
            const src = String(url ?? '').trim() || character?.src;
            if (!src) {
                toastr.warning('Give an image URL, or open a character.', TITLE);
                return '';
            }
            try {
                const path = await removeBackground(src, String(url ?? '').trim() ? undefined : character?.name);
                if (String(args.show) === 'true') {
                    showCutout(path, character?.name ?? 'Image');
                }
                return path;
            } catch (error) {
                reportError(error);
                return '';
            }
        },
    }));
}

jQuery(() => {
    addMenuItem();
    addSlashCommand();
});
