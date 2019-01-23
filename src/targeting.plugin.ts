import * as path from 'path';
import { compilation, Compiler, ExternalsElement, Loader, Plugin } from 'webpack';

import ContextModuleFactory = compilation.ContextModuleFactory;
import Dependency           = compilation.Dependency;
import NormalModuleFactory  = compilation.NormalModuleFactory;

import { BabelTarget }                       from './babel.target';
import { BlindTargetingError }               from './blind.targeting.error';
import { KNOWN_EXCLUDED, STANDARD_EXCLUDED } from './excluded.packages';
import { BabelMultiTargetLoader }            from './babel.multi.target.loader';
import { PLUGIN_NAME }                       from './plugin.name';

const NOT_TARGETED = [
    /\.s?css$/,
];

// picks up where BabelTargetEntryPlugin leaves off and takes care of targeting all dependent modules
// includes special case handling for Angular lazy routes

/**
 * @internalapi
 */
export class TargetingPlugin implements Plugin {

    private babelLoaderPath = require.resolve('babel-loader');
    private babelLoaders: { [key: string]: any } = {};
    private remainingTargets: { [issuer: string]: { [file: string]: BabelTarget[] } } = {};
    private readonly doNotTarget: RegExp[];

    constructor(private targets: BabelTarget[], private exclude: RegExp[], doNotTarget: RegExp[], private readonly externals: ExternalsElement | ExternalsElement[]) {
        this.doNotTarget = NOT_TARGETED.concat(doNotTarget || []);
    }

    public apply(compiler: Compiler): void {

        // make sure our taps come after other plugins (particularly AngularCompilerPlugin)
        compiler.hooks.afterPlugins.tap(PLUGIN_NAME, () => {

            compiler.hooks.contextModuleFactory.tap(PLUGIN_NAME, (cmf: ContextModuleFactory) => {
                cmf.hooks.afterResolve.tapPromise(PLUGIN_NAME, this.targetLazyModules.bind(this));
            });

            compiler.hooks.normalModuleFactory.tap(PLUGIN_NAME, (nmf: NormalModuleFactory) => {

                nmf.hooks.module.tap(PLUGIN_NAME, this.targetModule.bind(this));
                nmf.hooks.afterResolve.tapPromise(PLUGIN_NAME, this.afterResolve.bind(this));

            });

            compiler.hooks.watchRun.tapPromise(PLUGIN_NAME, async () => {
                this.remainingTargets = {};
            });

        });
    }

    // HACK ALERT!
    // Sometimes, there just isn't a way to trace a request back to a targeted module or entry. This happens with
    // Angular's lazy loaded routes and ES6 dynamic imports. With dynamic imports, we'll get a pair of requests for each
    // time a module is dynamically referenced. The best we can do is just fake it - create an array for each request
    // that has a copy of the targets array, and assign a the first remaining target to each request
    private getBlindTarget(issuer: string, key: string): BabelTarget {
        if (!this.remainingTargets) {
            this.remainingTargets = {};
        }
        if (!this.remainingTargets[issuer]) {
            this.remainingTargets[issuer] = {};
        }

        if (!this.remainingTargets[issuer][key]) {
            this.remainingTargets[issuer][key] = this.targets.slice(0);
        }

        if (!this.remainingTargets[issuer][key].length) {
            throw new BlindTargetingError(key);
        }

        return this.remainingTargets[issuer][key].shift();
    }

    public async targetLazyModules(resolveContext: any) {

        // handle lazy modules from AngularCompilerPlugin
        if (resolveContext.mode === 'lazy' &&
            resolveContext.resource &&
            resolveContext.resource.endsWith('$$_lazy_route_resource')
        ) {

            // FIXME: Mixing Harmony and CommonJs requires of @angular/core breaks lazy loading!
            // if this is happening, it's likely that a dependency has not correctly provided a true ES6 module and is
            // instead providing CommonJs module.
            const babelTarget = this.getBlindTarget(resolveContext.context, resolveContext.resource);

            resolveContext.resource = babelTarget.getTargetedRequest(resolveContext.resource);

            // track a map of resources to targets
            if (!resolveContext.resolveOptions.babelTargetMap) {
                resolveContext.resolveOptions.babelTargetMap = {};
            }
            resolveContext.resolveOptions.babelTargetMap[resolveContext.resource] = babelTarget;

            // piggy-back on angular's resolveDependencies function to target the dependencies.
            const ogResolveDependencies = resolveContext.resolveDependencies;
            resolveContext.resolveDependencies = (_fs: any, _resource: any, cb: any) => {
                ogResolveDependencies(_fs, _resource, (err: Error, dependencies: Dependency[]) => {
                    this.targetDependencies(babelTarget, { dependencies });
                    cb(null, dependencies);
                });
            };

            this.targetDependencies(babelTarget, resolveContext);

            return resolveContext;

        }
    }

    public targetModule(module: any): void {

        if (!this.isTargetedRequest(module, module.request)) {
            return;
        }

        let babelTarget = BabelTarget.getTargetFromTag(module.request, this.targets);
        if (!babelTarget) {
            return;
        }

        module.request = babelTarget.getTargetedRequest(module.request);
        if (!module.options) {
            module.options = {};
        }
        module.options.babelTarget = babelTarget;

        const ogAddDependency = module.addDependency;
        module.addDependency = (dep: any) => {
            this.targetDependency(dep, babelTarget);
            return ogAddDependency.call(module, dep);
        };
    }

    private targetDependency(dep: Dependency, babelTarget: BabelTarget): void {
        if (!dep.request || !this.isTargetedRequest(dep, dep.request)) {
            return;
        }

        // update the dependency requests to be targeted
        // only tag dep.request, not tag dep.userRequest, it breaks lazy loading
        // userRequest basically maps the user-friendly name to the actual request
        // so if the code does require('some-lazy-route/lazy.module.ngfactory.js') <-- userRequest
        // it can be mapped to 'some-lazy-route/lazy.module.ngfactory.js?babelTarget=modern <-- request
        if (dep.request) {
            dep.request = babelTarget.getTargetedRequest(dep.request);
        }
    }

    public targetDependencies(babelTarget: BabelTarget, context: any) {
        context.dependencies.forEach((dep: Dependency) => this.targetDependency(dep, babelTarget));
    }

    public async afterResolve(resolveContext: any): Promise<void> {
        const loaders: BabelMultiTargetLoader[] = resolveContext.loaders
            .filter((loaderInfo: any) => loaderInfo.options && loaderInfo.options.isBabelMultiTargetLoader);

        this.checkResolveTarget(resolveContext, !!loaders.length);
        this.replaceLoaders(resolveContext, loaders);
    }

    public checkResolveTarget(resolveContext: any, hasLoader: boolean): void {
        if (!this.isTargetedRequest(resolveContext, resolveContext.request) ||
            !this.isTranspiledRequest(resolveContext) ||
            !hasLoader) {
            return;
        }

        let babelTarget = BabelTarget.getTargetFromTag(resolveContext.request, this.targets);
        if (babelTarget) {
            this.targetChunkNames(resolveContext, babelTarget);
            return;
        }

        babelTarget = this.getTargetFromContext(resolveContext);
        if (babelTarget) {
            // this is probably a dynamic import, in which case the dependencies need to get targeted
            resolveContext.dependencies.forEach((dep: Dependency) => this.targetDependency(dep, babelTarget));
        } else {
            babelTarget = this.getBlindTarget(resolveContext.resourceResolveData.context.issuer, resolveContext.request);
        }

        this.targetChunkNames(resolveContext, babelTarget);

        resolveContext.request = babelTarget.getTargetedRequest(resolveContext.request);
        if (resolveContext.resource) {
            resolveContext.resource = babelTarget.getTargetedRequest(resolveContext.resource);
        }
    }

    private targetChunkNames(resolveContext: any, babelTarget: BabelTarget): void {
        resolveContext.dependencies.forEach((dep: any) => {
            if (!dep.block || !dep.block.groupOptions || !dep.block.groupOptions.name) {
                return;
            }
            dep.block.groupOptions.name = babelTarget.getTargetedAssetName(dep.block.groupOptions.name);
        });
    }

    public replaceLoaders(resolveContext: any, loaders: BabelMultiTargetLoader[]): void {

        let babelTarget: BabelTarget = resolveContext.resourceResolveData &&
            this.isTranspiledRequest(resolveContext) &&
            this.getTargetFromContext(resolveContext);

        loaders.forEach((loader: BabelMultiTargetLoader) => {
            const index = resolveContext.loaders.indexOf(loader);

            if (!babelTarget) {
                resolveContext.loaders.splice(index, 1);
                return;
            }

            const effectiveLoader = {
                loader: loader.loader,
                options: loader.options.loaderOptions,
                ident: (loader as any).ident,
            };
            if (loader.loader === this.babelLoaderPath) {
                resolveContext.loaders.splice(index, 1, this.getTargetedBabelLoader(effectiveLoader, babelTarget));
            } else {
                resolveContext.loaders.splice(index, 1, effectiveLoader);
            }
        });

    }

    public isTargetedRequest(context: any, request: string): boolean {
        if (this.doNotTarget && this.doNotTarget.find(entry => entry.test(request))) {
            return false;
        }

        return !this.isExternalRequest(context, request, this.externals);
    }

    private isExternalRequest(context: any, request: string, externals: ExternalsElement | ExternalsElement[]): boolean {
        if (!externals) {
            return false;
        }

        if (Array.isArray(externals)) {
            for (const ext of externals) {
                if (this.isExternalRequest(context, request, ext)) {
                    return true;
                }
            }
            return false;
        }

        if (typeof(externals) === 'function') {
            throw new Error('Using an ExternalsFunctionElement is not supported');
        }

        if (typeof(externals) === 'string') {
            return request === externals;
        }

        if (externals instanceof RegExp) {
            return externals.test(request);
        }

        if (typeof(externals) === 'object') {
            return this.isExternalRequest(context, request, Object.keys(externals));
        }

        return false;
    }

    public isTranspiledRequest(resolveContext: any): boolean {

        // ignore files/libs that are known to not need transpiling
        if (STANDARD_EXCLUDED.find(pattern => pattern.test(resolveContext.resource))) {
            // TODO: report this somewhere?
            // console.info('not transpiling request from STANDARD_EXCLUDED', resolveContext.resource);
            return false;
        }
        if (KNOWN_EXCLUDED.find(pattern => pattern.test(resolveContext.resource))) {
            // TODO: report this somewhere?
            // console.info('not transpiling request from KNOWN_EXCLUDED', resolveContext.resource);
            return false;
        }

        if (this.exclude.find(pattern => pattern.test(resolveContext.resolve))) {
            // TODO: report this somewhere?
            // console.info('not transpiling request from excluded patterns', resolveContext.resource);
            return false;
        }

        const pkgRoot = resolveContext.resourceResolveData.descriptionFileRoot;
        const pkg = resolveContext.resourceResolveData.descriptionFileData;

        // coming from a package's "main" or "browser" field? don't need to transpile
        if (pkg.main && resolveContext.resource === path.resolve(pkgRoot, pkg.main)) {
            // TODO: report this somewhere?
            // console.info('not transpiling request using package "main"', resolveContext.resource);
            return false;
        }
        if (pkg.browser) {
            // TODO: report this somewhere?
            // console.info('not transpiling request using package "browser"', resolveContext.resource);
            if (typeof(pkg.browser) === 'string' && resolveContext.resource === path.resolve(pkgRoot, pkg.browser)) {
                return false;
            }
            if (Array.isArray(pkg.browser) &&
                pkg.browser.find((entry: string) => resolveContext.resource === path.resolve(pkgRoot, entry))
            ) {
                return false;
            }
            if (typeof(pkg.browser === 'object') &&
                Object.values(pkg.browser).find((entry: string) => resolveContext.resource === path.resolve(pkgRoot, entry))
            ) {
                return false;
            }

        }

        return true;
    }

    public getTargetFromContext(context: any): BabelTarget {
        if (context.contextInfo && context.contextInfo.babelTarget) {
            return context.contextInfo.babelTarget;
        }
        if (context.resourceResolveData &&
            context.resourceResolveData.context &&
            context.resourceResolveData.context.babelTarget
        ) {
            return context.resourceResolveData.context.babelTarget;
        }
        const dependencies = context.dependencies;
        for (const dep of dependencies) {
            if (dep.babelTarget) {
                return dep.babelTarget;
            }
            if (dep.originModule) {
                const target = BabelTarget.findTarget(dep.originModule);
                if (target) {
                    return target;
                }
            }
        }
    }

    private getTargetedBabelLoader(loader: any, babelTarget: BabelTarget) {
        if (!this.babelLoaders[babelTarget.key]) {
            this.babelLoaders[babelTarget.key] = Object.assign({}, loader, {
                loader: this.babelLoaderPath,
                options: babelTarget.options,
            });
        }
        return this.babelLoaders[babelTarget.key];
    }

    public static loader(loader?: Loader): Loader {
        return new BabelMultiTargetLoader(loader);
    }

}
