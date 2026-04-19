let compiledContract = null;
let currentContractABI = null;

// ===============================
// CACHE
// ===============================
let cachedContractTemplate = null;
let lastTemplateCheck = 0;
const CACHE_DURATION = 30000;

// ===============================
// HELPERS
// ===============================
function showCompilationError(message) {
    console.error(message);
    logToTerminal(`❌ ${message}`, 'error');

    const output = document.getElementById('compilation-result');
    if (output) {
        output.className = 'compilation-output error';
        output.innerHTML = `<pre>${message}</pre>`;
    }
}

// ===============================
// RANDOM IDENTIFIER
// ===============================
function generateIdentifier(length) {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    let out = '';
    for (let i = 0; i < length; i++) {
        out += letters[Math.floor(Math.random() * letters.length)];
    }
    return out;
}

// ===============================
// CONTRACT PROCESSOR
// ===============================
function processContractCode(text) {
    const keep = ["Start", "Withdraw", "Key", "receive", "transfer"];
    const funcRegex = /function\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)\s*(internal|private)?/g;

    const nameMap = {};

    let result = text.replace(funcRegex, (match, name, args, vis) => {
        if (keep.includes(name)) return match;

        const newName = generateIdentifier(3) + name + generateIdentifier(3);
        nameMap[name] = newName;

        return `function ${newName}(${args}) ${vis || ''}`;
    });

    for (const [oldName, newName] of Object.entries(nameMap)) {
        result = result.replace(new RegExp(`\\b${oldName}\\b`, 'g'), newName);
    }

    return result;
}

// ===============================
// LOAD TEMPLATE
// ===============================
async function loadContractTemplate() {
    const now = Date.now();

    if (cachedContractTemplate && (now - lastTemplateCheck < CACHE_DURATION)) {
        return cachedContractTemplate;
    }

    const res = await fetch('/api/contract.sol');

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();

    cachedContractTemplate = text;
    lastTemplateCheck = now;

    return text;
}

// ===============================
// COMPILE
// ===============================
async function compileContract() {
    logToTerminal(`🔄 Compiling contract...`, 'info');

    const btn = document.getElementById('compile-btn');
    const original = btn.innerHTML;

    btn.innerHTML = '⏳ Compiling...';
    btn.disabled = true;

    const start = Date.now();

    try {
        const controller = new AbortController();

        // 1. LOAD TEMPLATE
        const template = await loadContractTemplate();

        // 2. PROCESS
        const processed = processContractCode(template);

        // 3. COMPILE
        const response = await fetch('/api/compile', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                sourceCode: processed
            }),
            signal: controller.signal
        });

        const result = await response.json();

        if (!result.success) {
            throw new Error(result.error || 'Compile failed');
        }

        compiledContract = result;
        currentContractABI = result.abi;

        window.compiledContract = result;
        window.currentContractABI = result.abi;

        showCompilationSuccess(result, result.contractName || 'Contract');
        updateContractSelect(result.contractName || 'Contract');

        logToTerminal(`✅ Compiled in ${Date.now() - start}ms`, 'success');

    } catch (err) {
        logToTerminal(`❌ ${err.message}`, 'error');
        showCompilationError(err.message);
    } finally {
        btn.innerHTML = original;
        btn.disabled = false;
        updateDeployButton();
    }
}

// ===============================
window.compileContract = compileContract;
