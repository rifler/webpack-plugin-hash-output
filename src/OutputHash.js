const crypto = require('crypto');
const fs = require('fs');
const outdent = require('outdent');

function OutputHash({
    validateOutput = false,
    validateOutputRegex = /^.*$/,
    replacementFilterRegex = null,
} = {}) {
    this.validateOutput = validateOutput;
    this.validateOutputRegex = validateOutputRegex;

    // we don't specify /^.*$/ as a default so we can tell the difference between this option being
    // set or not in the check below
    this.replacementFilterRegex = replacementFilterRegex || /^.*$/;

    // This is used to determine whether to perform the "safety-net" check for old hashes, it is enabled
    // only if the `replacementFilterRegex` option is passed in.
    this.shouldPerformReplacementValidation = replacementFilterRegex !== null;
}

/**
 * Replaces a string in an asset
 */
function replaceStringInAsset(asset, source, target) {
    const sourceRE = new RegExp(source, 'g');

    if (typeof asset === 'string') {
        return asset.replace(sourceRE, target);
    }

    // ReplaceSource
    if ('_source' in asset) {
        asset._source = replaceStringInAsset(asset._source, source, target);
        return asset;
    }

    // CachedSource
    if ('_cachedSource' in asset) {
        asset._cachedSource = asset.source().replace(sourceRE, target);
        return asset;
    }

    // RawSource / SourceMapSource
    if ('_value' in asset) {
        asset._value = asset.source().replace(sourceRE, target);
        return asset;
    }

    // ConcatSource
    if ('children' in asset) {
        asset.children = asset.children.map(child => replaceStringInAsset(child, source, target));
        return asset;
    }

    throw new Error(
        `Unknown asset type (${asset.constructor.name})!. ` +
            'Unfortunately this type of asset is not supported yet. ' +
            'Please raise an issue and we will look into it asap'
    );
}

/* matches contents of asset against a regex */
function assetContainsRegex(asset, regex) {
    if (typeof asset === 'string') {
        return asset.match(regex);
    }

    // ReplaceSource
    if ('_source' in asset) {
        return assetContainsRegex(asset._source, regex);
    }

    if (typeof asset.source === 'function') {
        return asset.source().match(regex);
    }

    // ConcatSource
    if ('children' in asset) {
        return asset.children.some(child => assetContainsRegex(child, regex));
    }

    throw new Error(
        `Unknown asset type (${asset.constructor.name})!. ` +
            'Unfortunately this type of asset is not supported yet. ' +
            'Please raise an issue and we will look into it asap'
    );
}

/**
 * Computes the new hash of a chunk.
 *
 * This function updates the *name* of the main file (i.e. source code), and the *content* of the
 * secondary files (i.e source maps)
 */
function reHashChunk(chunk, assets, hashFn, nameMap, replacementFilterRegex) {
    const isMainFile = file => file.endsWith('.js') || file.endsWith('.css');

    // Update the name of the main files
    chunk.files.filter(isMainFile).forEach((oldChunkName, index) => {
        const asset = assets[oldChunkName];
        const { fullHash, shortHash: newHash } = hashFn(asset.source());

        let newChunkName;

        if (oldChunkName.includes(chunk.renderedHash)) {
            // Save the hash map for replacing the secondary files
            nameMap[chunk.renderedHash] = newHash;
            newChunkName = oldChunkName.replace(chunk.renderedHash, newHash);

            // Keep the chunk hashes in sync
            chunk.hash = fullHash;
            chunk.renderedHash = newHash;
        } else {
            // This is a massive hack:
            //
            // The oldHash of the main file is in `chunk.renderedHash`. But some plugins add a
            // second "main" file to the chunk (for example, `mini-css-extract-plugin` adds a
            // css file). That other main file has to be rehashed too, but we don't know the
            // oldHash of the file, so we don't know what string we have to replace by the new
            // hash.
            //
            // However, the hash present in the file name must be one of the hashes of the
            // modules inside the chunk (modules[].renderedHash). So we try to replace each
            // module hash with the new hash.
            const module = Array.from(chunk.modulesIterable).find(m =>
                oldChunkName.includes(m.renderedHash)
            );

            // Can't find a module with this hash... not sure what is going on, just return and
            // hope for the best.
            if (!module) return;

            // Save the hash map for replacing the secondary files
            nameMap[module.renderedHash] = newHash;
            newChunkName = oldChunkName.replace(module.renderedHash, newHash);

            // Keep the module hashes in sync
            module.hash = fullHash;
            module.renderedHash = newHash;
        }

        // Change file name to include the new hash
        chunk.files[index] = newChunkName;
        asset._name = newChunkName;
        delete assets[oldChunkName];
        assets[newChunkName] = asset;
    });

    // Update the content of the rest of the files in the chunk
    chunk.files
        .filter(file => !isMainFile(file) && file.match(replacementFilterRegex))
        .forEach(file => {
            Object.keys(nameMap).forEach(old => {
                const newHash = nameMap[old];
                replaceStringInAsset(assets[file], old, newHash);
            });
        });
}

/**
 * Replaces old hashes for new hashes in chunk files.
 *
 * This function iterates through file contents and replaces all the ocurrences of old hashes
 * for new ones. We assume hashes are unique enough, so that we don't accidentally hit a
 * collision and replace existing data.
 */
function replaceOldHashForNewInChunkFiles(
    chunk,
    assets,
    oldHashToNewHashMap,
    replacementFilterRegex
) {
    chunk.files
        .filter(file => file.match(replacementFilterRegex))
        .forEach(file => {
            Object.keys(oldHashToNewHashMap).forEach(oldHash => {
                const newHash = oldHashToNewHashMap[oldHash];
                replaceStringInAsset(assets[file], oldHash, newHash);
            });
        });
}

function sortChunksById(a, b) {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
}

OutputHash.prototype.apply = function apply(compiler) {
    let hashFn;

    compiler.hooks.afterPlugins.tap('OutputHash', (compiler, callback) => {
        if (
            compiler.hooks.emit.taps.length > 1 &&
            compiler.hooks.emit.taps[0].name !== 'OutputHash'
        ) {
            debugger;
            const plugins = compiler.hooks.emit.taps
                .filter(plugin => plugin.name != 'OutputHash')
                .map(plugin => ` * ${plugin.name}`)
                .join('\n');

            console.warn(outdent`
                [WARNING] There are other plugins configured that might interfere with webpack-plugin-hash-output.
                For this plugin to work correctly, it should be the first plugin in the "emit" phase. Please
                be sure that the rest of the plugins run after webpack-plugin-hash-output (ensure they are listed
                after webpack-plugin-hash-output in the 'plugins' option in your webpack config).

                Plugins that could interfere with webpack-plugin-hash-output:
                ${plugins}
                `);
        }
    });

    compiler.hooks.emit.tapAsync('OutputHash', (compilation, callback) => {
        const { outputOptions, chunks, assets } = compilation;
        const { hashFunction, hashDigest, hashDigestLength, hashSalt } = outputOptions;

        // Reuses webpack options
        hashFn = input => {
            const hashObj = crypto.createHash(hashFunction).update(input);
            if (hashSalt) hashObj.update(hashSalt);
            const fullHash = hashObj.digest(hashDigest);
            return { fullHash, shortHash: fullHash.substr(0, hashDigestLength) };
        };

        const nameMap = {};
        const sortedChunks = chunks.slice().sort((aChunk, bChunk) => {
            const aEntry = aChunk.hasRuntime();
            const bEntry = bChunk.hasRuntime();
            if (aEntry && !bEntry) return 1;
            if (!aEntry && bEntry) return -1;
            return sortChunksById(aChunk, bChunk);
        });

        sortedChunks.forEach(chunk => {
            replaceOldHashForNewInChunkFiles(chunk, assets, nameMap, this.replacementFilterRegex);
            reHashChunk(chunk, assets, hashFn, nameMap, this.replacementFilterRegex);
        });

        // if we are only replacing hashes in some files, we execute a safety net to ensure
        // that we haven't missed any files that might contain hashes
        if (this.shouldPerformReplacementValidation) {
            const newHashes = Object.keys(nameMap).map(key => nameMap[key]);

            // we filter the oldHashes to remove any that were also newHashes, in case some hashes
            // didn't change
            const oldHashes = Object.keys(nameMap).filter(hash => !newHashes.includes(hash));
            const regex = new RegExp(`(${oldHashes.join('|')})`, 'g');

            const filesWithOldHashes = sortedChunks.reduce(
                (acc, chunk) =>
                    acc.concat(chunk.files.filter(file => assetContainsRegex(assets[file], regex))),
                []
            );

            if (filesWithOldHashes.length > 0) {
                callback(
                    new Error(
                        `Some files still had the old hashes:\n${filesWithOldHashes.join('\n')}`
                    )
                );
                return;
            }
        }

        callback();
    });

    if (this.validateOutput) {
        compiler.hooks.afterEmit.tapAsync('Validate output', (compilation, callback) => {
            const outputPath = compilation.getPath(compiler.outputPath);
            let err;
            Object.keys(compilation.assets)
                .filter(assetName => assetName.match(this.validateOutputRegex))
                .forEach(assetName => {
                    // With `futureEmitAssets` mode in Webpack 4 (or the default behaviour in Webpack 5) we lose
                    // the `asset.existsAt` property as the asset is replaced with `SizeOnlySource` to allow GC of
                    // the asset.
                    //
                    // This logic mirrors how Webpack determines the filename to write to internally so we can find the
                    // file again.
                    let targetFile = assetName;
                    const queryStringIdx = targetFile.indexOf('?');
                    if (queryStringIdx >= 0) {
                        targetFile = targetFile.substr(0, queryStringIdx);
                    }
                    const path = compiler.outputFileSystem.join(outputPath, targetFile);

                    const assetContent = fs.readFileSync(path, 'utf8');
                    const { shortHash } = hashFn(assetContent);
                    if (!assetName.includes(shortHash)) {
                        err = new Error(
                            `The hash in ${assetName} does not match the hash of the content (${shortHash})`
                        );
                    }
                });
            return callback(err);
        });
    }
};

module.exports = OutputHash;
