// Project Save: a collapsed panel at the bottom of txt2img and img2img. See scripts/project_save.py.
(function () {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const app = () => gradioApp();
    const UNSTABLE = /^(component-\d+|range_id_\d+)$/;
    const IMAGE_ID = /^(img2img_image|img2img_sketch|img2maskimg|inpaint_sketch|img_inpaint_base|img_inpaint_mask)$|_controlnet_ControlNet-\d+_(input_image|mask_image)$/;

    function kindOf(el) {
        if (el.tagName === "TEXTAREA") return "text";
        if (el.closest(".gradio-dropdown")) return el.closest(".gradio-dropdown").querySelector(".token") ? "multi" : "dropdown";
        return ["checkbox", "radio", "range", "number"].includes(el.type) ? el.type : "text";
    }

    // Every control gets a key that survives a restart: its nearest stable id, its kind, and its place there.
    function controls(root) {
        const counts = {}, out = [];
        for (const el of root.querySelectorAll("input, textarea")) {
            if (el.type === "file" || el.type === "hidden" || el.closest(".project-save-panel")) continue;
            let anchor = el.id && !UNSTABLE.test(el.id) ? el : null;
            for (let p = el.parentElement; !anchor && p && p !== root; p = p.parentElement) {
                if (p.id && !UNSTABLE.test(p.id)) anchor = p;
            }
            if (!anchor) continue;
            const kind = kindOf(el), base = `${anchor.id}|${kind}`;
            counts[base] = (counts[base] || 0) + 1;
            out.push({key: `${base}|${counts[base]}`, kind, el});
        }
        return out;
    }

    const read = c => (c.kind === "checkbox" || c.kind === "radio") ? (c.el.checked ? c.el.value || "on" : "") : c.el.value;
    const readAll = root => controls(root).filter(c => c.kind !== "multi").map(c => ({key: c.key, kind: c.kind, value: read(c)}));
    const subTab = () => [...app().querySelectorAll("#mode_img2img .tab-nav button")].find(b => b.classList.contains("selected"))?.textContent.trim();

    function fileToUrl(blob) {
        return new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
    }

    // A painted mask lives only on the canvas, so it is saved as white on black.
    function paintedMask() {
        const c = app().querySelector("#img2maskimg canvas[key=mask]");
        if (!c || !c.width) return null;
        const src = c.getContext("2d").getImageData(0, 0, c.width, c.height);
        const out = document.createElement("canvas");
        out.width = c.width; out.height = c.height;
        const x = out.getContext("2d"), img = x.createImageData(c.width, c.height);
        let painted = 0;
        for (let i = 0; i < src.data.length; i += 4) {
            const on = src.data[i + 3] > 0 ? 255 : 0;
            painted += on ? 1 : 0;
            img.data[i] = img.data[i + 1] = img.data[i + 2] = on;
            img.data[i + 3] = 255;
        }
        if (!painted) return null;
        x.putImageData(img, 0, 0);
        return out.toDataURL("image/png");
    }

    async function save(tab, project, note, folder) {
        const root = app().querySelector(`#tab_${tab}`);
        const images = {};
        for (const box of root.querySelectorAll("[id]")) {
            if (!IMAGE_ID.test(box.id)) continue;
            const img = box.querySelector("img");
            if (img?.naturalWidth) images[box.id] = await fileToUrl(await (await fetch(img.src)).blob());
        }
        if (tab === "img2img") {
            const mask = paintedMask();
            if (mask) images.painted_mask = mask;
        }
        const body = {
            project, note, folder, tab, images,
            subtab: tab === "img2img" ? subTab() : null,
            fields: readAll(root),
            quick: readAll(app().querySelector("#quicksettings")),
        };
        const r = await fetch("/project_save/save", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
        if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
        return r.json();
    }

    // Show any tab the element is hidden in, so its dropdown can open.
    async function reveal(el) {
        for (let item = el.closest(".tabitem"); item; item = item.parentElement.closest(".tabitem")) {
            if (getComputedStyle(item).display !== "none") continue;
            const tabs = item.parentElement;
            const n = [...tabs.children].filter(c => c.classList.contains("tabitem")).indexOf(item);
            tabs.querySelector(":scope > .tab-nav")?.querySelectorAll("button")[n]?.click();
            await sleep(250);
        }
    }

    async function pick(el, value) {
        await reveal(el);
        el.focus();
        for (const type of ["focus", "mousedown", "click"]) el.dispatchEvent(new Event(type, {bubbles: true}));
        await sleep(300);
        const box = el.closest(".gradio-dropdown");
        const option = [...box.querySelectorAll("ul li")].find(l => l.textContent.replace(/^\s*✓?\s*/, "").trim() === value);
        if (option) {
            for (const type of ["mousedown", "mouseup"]) option.dispatchEvent(new MouseEvent(type, {bubbles: true}));
            option.click();
            await sleep(250);
        }
        el.blur();
        await sleep(150);
    }

    function setValue(el, value) {
        el.value = value;
        el.dispatchEvent(new Event("input", {bubbles: true}));
        el.dispatchEvent(new Event("change", {bubbles: true}));
    }

    // Choices can change what other controls show or hold (the ControlNet type sets its model, say), so repeat
    // until the page matches the save. Returns the keys that still differ.
    async function applyFields(root, fields) {
        const wanted = new Map(fields.map(f => [f.key, f]));
        let left = [];
        for (let pass = 0; pass < 3; pass++) {
            left = [];
            for (const kind of ["checkbox", "radio", "dropdown", "range", "number", "text"]) {
                for (const c of controls(root).filter(c => c.kind === kind)) {
                    const f = wanted.get(c.key);
                    if (!f || read(c) === f.value) continue;
                    if (kind === "checkbox" || kind === "radio") {
                        if (kind === "checkbox" || f.value) c.el.click();
                    } else if (kind === "dropdown") {
                        await pick(c.el, f.value);
                    } else {
                        setValue(c.el, f.value);
                    }
                }
                await sleep(kind === "checkbox" || kind === "radio" ? 500 : 100);
            }
            await sleep(600);
            const now = new Map(controls(root).map(c => [c.key, c]));
            left = fields.filter(f => f.kind !== "multi" && (!now.has(f.key) || read(now.get(f.key)) !== f.value)).map(f => f.key);
            if (!left.length) break;
        }
        return left;
    }

    async function putImage(boxId, url) {
        const box = app().querySelector(`#${boxId}`);
        if (!box) return false;
        await reveal(box);
        box.querySelector('button[aria-label="Remove Image"], button[title="Remove Image"]')?.click();
        await sleep(500);
        const input = box.querySelector("input[type=file]");
        if (!input) return false;
        const blob = await (await fetch(url)).blob();
        const data = new DataTransfer();
        data.items.add(new File([blob], `${boxId}.png`, {type: blob.type}));
        input.files = data.files;
        input.dispatchEvent(new Event("change", {bubbles: true}));
        await sleep(1000);
        return true;
    }

    async function load(project, version, folder) {
        const r = await fetch(`/project_save/load?project=${encodeURIComponent(project)}&version=${encodeURIComponent(version)}&folder=${encodeURIComponent(folder || "")}`);
        if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
        const state = await r.json();
        [...app().querySelectorAll("#tabs > .tab-nav button")].find(b => b.textContent.trim() === state.tab)?.click();
        await sleep(500);

        const images = {...state.images};
        let subtab = state.subtab;
        if (images.painted_mask) {
            // A painted mask can't be put back on the canvas, so it comes back through Inpaint upload.
            images.img_inpaint_mask = images.painted_mask;
            images.img_inpaint_base = images.img2maskimg || images.img_inpaint_base;
            if (subtab === "Inpaint") subtab = "Inpaint upload";
            delete images.painted_mask;
        }
        const missing = [];
        for (const [id, url] of Object.entries(images)) {
            if (!await putImage(id, url)) missing.push(id);
        }
        const root = app().querySelector(`#tab_${state.tab}`);
        const left = await applyFields(root, state.fields);
        const leftQuick = await applyFields(app().querySelector("#quicksettings"), state.quick || []);
        if (subtab) {
            [...app().querySelectorAll("#mode_img2img .tab-nav button")].find(b => b.textContent.trim() === subtab)?.click();
        }
        return {images: Object.keys(images).length, missing, notRestored: [...left, ...leftQuick], fields: state.fields.length, subtab, note: state.note};
    }

    async function refresh(panel) {
        const list = await (await fetch("/project_save/list")).json();
        const select = panel.querySelector("select");
        select.innerHTML = "";
        for (const p of list) {
            for (const v of p.versions) select.add(new Option(`${p.project} / ${v}  (${p.folder})`, JSON.stringify([p.project, v, p.folder])));
        }
    }

    function buildPanel(tab) {
        const panel = document.createElement("details");
        panel.className = "project-save-panel";
        panel.id = `project_save_${tab}`;
        panel.innerHTML = `<summary>Project Save</summary>
            <div class="project-save-row"><input type="text" placeholder="Project name"><input type="text" placeholder="Note (optional)"><input type="text" placeholder="Save to, like Z:\\Projects (blank = outputs\\projects)"><button class="ps-save">Save Project</button></div>
            <div class="project-save-row"><select></select><button class="ps-load">Load Project</button></div>
            <div class="project-save-status"></div>`;
        const status = panel.querySelector(".project-save-status");
        const say = text => { status.textContent = text; };
        const [name, note, folder] = panel.querySelectorAll("input");
        panel.addEventListener("toggle", () => panel.open && refresh(panel));
        panel.querySelector(".ps-save").onclick = async () => {
            say("Saving...");
            try {
                const r = await save(tab, name.value, note.value, folder.value);
                say(`Saved ${r.project} / ${r.version} with ${r.images} image(s): ${r.folder}`);
                await refresh(panel);
            } catch (e) { say(`Not saved: ${e.message}`); }
        };
        panel.querySelector(".ps-load").onclick = async () => {
            const value = panel.querySelector("select").value;
            if (!value) return say("Nothing saved yet.");
            say("Loading...");
            try {
                const r = await load(...JSON.parse(value));
                const problems = r.notRestored.length ? ` ${r.notRestored.length} setting(s) did not restore: ${r.notRestored.join(", ")}.` : " All settings match the save.";
                say(`Loaded ${r.images} image(s).${problems}${r.missing.length ? ` Images not placed: ${r.missing.join(", ")}.` : ""}${r.subtab ? ` Tab: ${r.subtab}.` : ""}`);
            } catch (e) { say(`Not loaded: ${e.message}`); }
        };
        return panel;
    }

    onUiLoaded(() => {
        for (const tab of ["txt2img", "img2img"]) app().querySelector(`#tab_${tab}`)?.appendChild(buildPanel(tab));
    });
    window.projectSave = {save, load};
})();
