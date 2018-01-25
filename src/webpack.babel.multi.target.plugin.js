const webpack = require('webpack');
const merge = require('webpack-merge');
const _  = require('lodash');

const CHILD_COMPILER_PREFIX = 'webpack-babel-multi-target-compiler-';
const BABEL_LOADER = 'babel-loader';

const FILTERED_PLUGINS = [

    // child compilation does not play nice with this one
    // causes 
    'HardSourceWebpackPlugin',

    'HtmlWebpackPlugin',
];

/**
 *
 * @param {WebpackBabelMultiTargetOptions} multiTargetOptions
 * @constructor
 */
class WebpackBabelMultiTargetPlugin {
    constructor(...multiTargetOptions) {
        if (!multiTargetOptions.length) {
            throw new Error('Must provide at least one WebpackBabelMultiTargetOptions object');
        }
        multiTargetOptions.forEach(options => {
            if (!options.browserProfile) {
                throw new Error('WebpackBabelMultiTargetOptions.browserProfile is required');
            }
            if (options.plugins && typeof(options.plugins) !== 'function') {
                throw new Error('WebpackBabelMultiTargetOptions.plugins must be a function');
            }
            if (!options.key) {
                options.key = options.browserProfile;
            }
        });
        this.multiTargetOptions = multiTargetOptions;
    }

    apply(compiler) {

        let multiTargetOptions = this.multiTargetOptions;
        let pluginSelf = this;
        let compilationBrowserProfiles = {};

        function findBabelRules(rules) {
            let result = [];
            for (let i = 0; i < rules.length; i++) {
                let rule = rules[i];
                if (rule.loader === BABEL_LOADER || rule.use === BABEL_LOADER) {
                    result.push(rule);
                    continue;
                }
                if (rule.use) {
                    let babelRules = findBabelRules(rule.use);
                    if (babelRules) {
                        result.push(...babelRules);
                    }
                }
            }
            return result;
        }

        const childCompilers = multiTargetOptions.map(multiTargetOption => {
            let config = merge({}, compiler.options);

            let plugins = multiTargetOption.plugins ? multiTargetOption.plugins() : config.plugins;
            // remove plugin (self) and any HtmlWebpackPlugin instances
            config.plugins = plugins.filter(plugin =>
                plugin !== pluginSelf &&
                plugin.constructor !== WebpackBabelMultiTargetPlugin &&
                FILTERED_PLUGINS.indexOf(plugin.constructor.name) < 0
            );

            compiler.options.plugins.forEach(plugin => {
                if (config.plugins.includes(plugin)) {
                    console.error('Found plugin instance duplication:', plugin.constructor.name);
                    throw new Error('Same plugin instance referenced from both original and child compilations. Use the plugins option to specify a plugin configuration factory and move all plugin instantiations into it.');
                }
            });

            // reassign the babel loader options
            let babelRules = findBabelRules(config.module.rules);
            if (!babelRules.length) {
                throw new Error('Could not find any babel-loader rules');
            }
            babelRules.forEach(babelRule => babelRule.options = multiTargetOption.options);

            let childCompiler = webpack(config);
            childCompiler.name = `${CHILD_COMPILER_PREFIX}${multiTargetOption.key}`;
            compilationBrowserProfiles[childCompiler.name] = multiTargetOption.browserProfile;

            childCompiler.plugin('compilation', compilation => {
                // add the key as the chunk name suffix for any chunks created
                compilation.plugin('before-chunk-ids', chunks => {
                    chunks.forEach(chunk => {
                        if (chunk.name) {
                            chunk.name += `.${multiTargetOption.key}`;
                        }
                    });
                });
            });

            return childCompiler;
        });

        compiler.plugin('compilation', compilation => {

            if (!compilation.name) {
                childCompilers.forEach(childCompiler => {
                    childCompiler.parentCompilation = compilation;
                });
            }

            // html-webpack-plugin helpers
            compilation.plugin('html-webpack-plugin-before-html-generation', function (htmlPluginData, callback) {
                // add assets from the child compilation
                compilation.children
                    .filter(child => child.name && child.name.startsWith(CHILD_COMPILER_PREFIX))
                    .forEach(child => {

                        let jsChunks = child.chunks.filter(chunk => chunk.files.find(file => file.endsWith('.js')));
                        // the plugin already sorted the chunks from the main compilation,
                        // so we'll need to do it for the children as well
                        let sortedChunks = htmlPluginData.plugin.sortChunks(
                            jsChunks,
                            htmlPluginData.plugin.options.chunksSortMode,
                        );

                        // generate the chunk objects used by the plugin
                        let htmlChunks = _.chain(sortedChunks)
                            .map(chunk => {
                                let entry = _.find(chunk.files, file => file.endsWith('.js'));
                                return [chunk.name, {
                                    css: [],
                                    entry,
                                    hash: chunk.hash,
                                    size: chunk.size({})
                                }];
                            })
                            .fromPairs()
                            .value();
                        Object.assign(htmlPluginData.assets.chunks, htmlChunks);

                        // add the asset names form the child
                        let assetNames = sortedChunks.map(chunk => chunk.files.find(file => file.endsWith('.js')));
                        htmlPluginData.assets.js.push(...assetNames);
                    });

                return callback(null, htmlPluginData);
            });

            compilation.plugin('html-webpack-plugin-alter-asset-tags', function (htmlPluginData, callback) {
                // update script tags for module loading
                let children = compilation.children.filter(child => child.name.startsWith(CHILD_COMPILER_PREFIX));

                htmlPluginData.head
                    .concat(htmlPluginData.body)
                    .filter(tag => tag.tagName === 'script')
                    .forEach(tag => {
                        let child = children.find(child => child.assets[tag.attributes.src]);
                        let isModernBundle;
                        if (child) {
                            // if the tag is for a bundle generated by a child compilation, we can determine
                            // whether it is a "modern" bundle by checking the target browserProfile type
                            isModernBundle = compilationBrowserProfiles[child.name] === 'modern';
                        } else {
                            // if the tag is for a bundle generated by the main compilation, we determine whether
                            // it is a modern bundle by checking if any of the child compilations are used to generate
                            // a legacy bundle. If that is the case, then (for now, at least), it is safe to assume
                            // that the main compilation was used to create a modern bundle
                            isModernBundle = !!multiTargetOptions.find(options => options.browserProfile === 'legacy');
                        }
                        if (isModernBundle) {
                            tag.attributes.type = 'module';
                        } else {
                            tag.attributes.nomodule = true;
                        }
                    });
                    return callback(null, htmlPluginData);
                });

        });

        compiler.plugin('make', function (compilation, callback) {
            Promise.all(childCompilers.map(childCompiler =>
                new Promise((resolve, reject) =>
                    childCompiler.runAsChild(err => {
                        if (err) {
                            return reject(err);
                        }
                        resolve();
                    })
                )
            ))
                .then(() => callback(), err => callback(err));
        });



    }
}
module.exports = WebpackBabelMultiTargetPlugin;