import crypto from 'crypto'
import path from 'path'
import PnpmError from '@pnpm/error'
import logger from '@pnpm/logger'
import { Dependencies } from '@pnpm/types'
import { depPathToFilename } from 'dependency-path'
import { KeyValuePair } from 'ramda'
import fromPairs from 'ramda/src/fromPairs'
import isEmpty from 'ramda/src/isEmpty'
import scan from 'ramda/src/scan'
import semver from 'semver'
import {
  DependenciesTree,
  DependenciesTreeNode,
  ResolvedPackage,
} from './resolveDependencies'
import {
  createNodeId,
  splitNodeId,
} from './nodeIdUtils'
import resolveDependencies from './resolveDependencies'

export interface GenericDependenciesGraphNode {
  // at this point the version is really needed only for logging
  modules: string
  dir: string
  children: {[alias: string]: string}
  depth: number
  peerDependencies?: Dependencies
  transitivePeerDependencies: Set<string>
  installable: boolean
  isBuilt?: boolean
  isPure: boolean
}

type PartialResolvedPackage = Pick<ResolvedPackage,
| 'depPath'
| 'name'
| 'peerDependencies'
| 'peerDependenciesMeta'
| 'version'
>

export interface GenericDependenciesGraph<T extends PartialResolvedPackage> {
  [depPath: string]: T & GenericDependenciesGraphNode
}

export default function<T extends PartialResolvedPackage> (
  opts: {
    projects: Array<{
      directNodeIdsByAlias: {[alias: string]: string}
      // only the top dependencies that were already installed
      // to avoid warnings about unresolved peer dependencies
      topParents: Array<{name: string, version: string}>
      rootDir: string // is only needed for logging
      id: string
    }>
    dependenciesTree: DependenciesTree<T>
    virtualStoreDir: string
    lockfileDir: string
    strictPeerDependencies: boolean
    installPeerDependencies: boolean
  }
): {
    dependenciesGraph: GenericDependenciesGraph<T>
    dependenciesByProjectId: {[id: string]: {[alias: string]: string}}
  } {
  const depGraph: GenericDependenciesGraph<T> = {}
  const pathsByNodeId = {}
  const _createPkgsByName = createPkgsByName.bind(null, opts.dependenciesTree)
  const rootProject = opts.projects.length > 1 ? opts.projects.find(({ id }) => id === '.') : null
  const rootPkgsByName = rootProject == null ? {} : _createPkgsByName(rootProject)

  for (const { directNodeIdsByAlias, topParents, rootDir } of opts.projects) {
    const pkgsByName = {
      ...rootPkgsByName,
      ..._createPkgsByName({ directNodeIdsByAlias, topParents }),
    }

    resolvePeersOfChildren(directNodeIdsByAlias, pkgsByName, {
      dependenciesTree: opts.dependenciesTree,
      depGraph,
      lockfileDir: opts.lockfileDir,
      pathsByNodeId,
      peersCache: new Map(),
      purePkgs: new Set(),
      rootDir,
      strictPeerDependencies: opts.strictPeerDependencies,
      installPeerDependencies: opts.installPeerDependencies,
      virtualStoreDir: opts.virtualStoreDir,
    })
  }

  Object.values(depGraph).forEach((node) => {
    node.children = Object.keys(node.children).reduce((acc, alias) => {
      acc[alias] = pathsByNodeId[node.children[alias]] ?? node.children[alias]
      return acc
    }, {})
  })

  const dependenciesByProjectId: {[id: string]: {[alias: string]: string}} = {}
  for (const { directNodeIdsByAlias, id } of opts.projects) {
    dependenciesByProjectId[id] = Object.keys(directNodeIdsByAlias).reduce((rootPathsByAlias, alias) => {
      rootPathsByAlias[alias] = pathsByNodeId[directNodeIdsByAlias[alias]]
      return rootPathsByAlias
    }, {})
  }
  return {
    dependenciesGraph: depGraph,
    dependenciesByProjectId,
  }
}

function createPkgsByName<T extends PartialResolvedPackage> (
  dependenciesTree: DependenciesTree<T>,
  { directNodeIdsByAlias, topParents }: {
    directNodeIdsByAlias: {[alias: string]: string}
    topParents: Array<{name: string, version: string}>
  }
) {
  return Object.assign(
    fromPairs(
      topParents.map(({ name, version }): KeyValuePair<string, ParentRef> => [
        name,
        {
          depth: 0,
          version,
        },
      ])
    ),
    toPkgByName(
      Object
        .keys(directNodeIdsByAlias)
        .map((alias) => ({
          alias,
          node: dependenciesTree[directNodeIdsByAlias[alias]],
          nodeId: directNodeIdsByAlias[alias],
        }))
    )
  )
}

type InstallPeer = { name: string, versionRange: string }

interface PeersCacheItem {
  depPath: string
  resolvedPeers: Array<[string, string]>
  missingPeers: string[]
  installPeers: InstallPeer[]
}

type PeersCache = Map<string, PeersCacheItem[]>

interface PeersResolution {
  missingPeers: string[]
  installPeers: InstallPeer[]
  resolvedPeers: Record<string, string>
}

function resolvePeersOfNode<T extends PartialResolvedPackage> (
  nodeId: string,
  parentParentPkgs: ParentRefs,
  ctx: {
    dependenciesTree: DependenciesTree<T>
    pathsByNodeId: {[nodeId: string]: string}
    depGraph: GenericDependenciesGraph<T>
    virtualStoreDir: string
    peersCache: PeersCache
    purePkgs: Set<string> // pure packages are those that don't rely on externally resolved peers
    rootDir: string
    lockfileDir: string
    strictPeerDependencies: boolean
    installPeerDependencies: boolean
  }
): PeersResolution {
  const node = ctx.dependenciesTree[nodeId]
  if (node.depth === -1) return { resolvedPeers: {}, missingPeers: [], installPeers: [] }
  const resolvedPackage = node.resolvedPackage as T
  if (
    ctx.purePkgs.has(resolvedPackage.depPath) &&
    ctx.depGraph[resolvedPackage.depPath].depth <= node.depth &&
    isEmpty(resolvedPackage.peerDependencies)
  ) {
    ctx.pathsByNodeId[nodeId] = resolvedPackage.depPath
    return { resolvedPeers: {}, missingPeers: [], installPeers: [] }
  }
  if (typeof node.children === 'function') {
    node.children = node.children()
  }
  const children = node.children
  const parentPkgs = isEmpty(children)
    ? parentParentPkgs
    : {
      ...parentParentPkgs,
      ...toPkgByName(
        Object.keys(children).map((alias) => ({
          alias,
          node: ctx.dependenciesTree[children[alias]],
          nodeId: children[alias],
        }))
      ),
    }
  const hit = ctx.peersCache.get(resolvedPackage.depPath)?.find((cache) =>
    cache.resolvedPeers
      .every(([name, cachedNodeId]) => {
        const parentPkgNodeId = parentPkgs[name]?.nodeId
        if (!parentPkgNodeId || !cachedNodeId) return false
        if (parentPkgs[name].nodeId === cachedNodeId) return true
        if (
          ctx.pathsByNodeId[cachedNodeId] &&
          ctx.pathsByNodeId[cachedNodeId] === ctx.pathsByNodeId[parentPkgs[name].nodeId!]
        ) return true
        const parentDepPath = (ctx.dependenciesTree[parentPkgNodeId].resolvedPackage as T).depPath
        if (!ctx.purePkgs.has(parentDepPath)) return false
        const cachedDepPath = (ctx.dependenciesTree[cachedNodeId].resolvedPackage as T).depPath
        return parentDepPath === cachedDepPath
      }) && cache.missingPeers.every((missingPeer) => !parentPkgs[missingPeer])
      // TODO installPeers?
  )
  if (hit != null) {
    ctx.pathsByNodeId[nodeId] = hit.depPath
    ctx.depGraph[hit.depPath].depth = Math.min(ctx.depGraph[hit.depPath].depth, node.depth)
    return {
      missingPeers: hit.missingPeers,
      resolvedPeers: fromPairs(hit.resolvedPeers),
      installPeers: [], // TODO?
    }
  }

  const {
    resolvedPeers: unknownResolvedPeersOfChildren,
    missingPeers: missingPeersOfChildren,
    installPeers: installPeersOfChildren,
  } = resolvePeersOfChildren(children, parentPkgs, ctx)

  const { resolvedPeers, missingPeers, installPeers } = isEmpty(resolvedPackage.peerDependencies)
    ? { resolvedPeers: {}, missingPeers: [], installPeers: [] }
    : resolvePeers({
      currentDepth: node.depth,
      dependenciesTree: ctx.dependenciesTree,
      lockfileDir: ctx.lockfileDir,
      nodeId,
      parentPkgs,
      resolvedPackage,
      rootDir: ctx.rootDir,
      strictPeerDependencies: ctx.strictPeerDependencies,
      installPeerDependencies: ctx.installPeerDependencies,
    })

  const allResolvedPeers = Object.assign(unknownResolvedPeersOfChildren, resolvedPeers)
  delete allResolvedPeers[node.resolvedPackage.name]
  const allMissingPeers = Array.from(new Set([...missingPeersOfChildren, ...missingPeers]))
  const allInstallPeers = Array.from(new Set([...installPeersOfChildren, ...installPeers]))

  let depPath: string
  if (isEmpty(allResolvedPeers)) {
    depPath = resolvedPackage.depPath
  } else {
    const peersFolderSuffix = createPeersFolderSuffix(
      Object.keys(allResolvedPeers)
        .map((alias) => ctx.dependenciesTree[allResolvedPeers[alias]].resolvedPackage)
        .map(({ name, version }) => ({ name, version })))
    depPath = `${resolvedPackage.depPath}${peersFolderSuffix}`
  }
  const localLocation = path.join(ctx.virtualStoreDir, depPathToFilename(depPath, ctx.lockfileDir))
  const modules = path.join(localLocation, 'node_modules')
  const isPure = isEmpty(allResolvedPeers) && allMissingPeers.length === 0
  if (isPure) {
    ctx.purePkgs.add(resolvedPackage.depPath)
  } else {
    const cache = {
      missingPeers: allMissingPeers,
      installPeers: allInstallPeers,
      depPath,
      resolvedPeers: Object.entries(allResolvedPeers),
    }
    if (ctx.peersCache.has(resolvedPackage.depPath)) {
      ctx.peersCache.get(resolvedPackage.depPath)!.push(cache)
    } else {
      ctx.peersCache.set(resolvedPackage.depPath, [cache])
    }
  }

  ctx.pathsByNodeId[nodeId] = depPath
  const peerDependencies = { ...resolvedPackage.peerDependencies }
  if (!ctx.depGraph[depPath] || ctx.depGraph[depPath].depth > node.depth) {
    const dir = path.join(modules, resolvedPackage.name)

    const transitivePeerDependencies = new Set<string>()
    const unknownPeers = [
      ...Object.keys(unknownResolvedPeersOfChildren),
      ...missingPeersOfChildren,
    ]
    if (unknownPeers.length > 0) {
      for (const unknownPeer of unknownPeers) {
        if (!peerDependencies[unknownPeer]) {
          transitivePeerDependencies.add(unknownPeer)
        }
      }
    }
    ctx.depGraph[depPath] = {
      ...(node.resolvedPackage as T),
      children: Object.assign(
        getPreviouslyResolvedChildren(nodeId, ctx.dependenciesTree),
        children,
        resolvedPeers
      ),
      depPath,
      depth: node.depth,
      dir,
      installable: node.installable,
      isPure,
      modules,
      peerDependencies,
      transitivePeerDependencies,
    }
  }
  return { resolvedPeers: allResolvedPeers, missingPeers: allMissingPeers, installPeers: allInstallPeers }
}

// When a package has itself in the subdependencies, so there's a cycle,
// pnpm will break the cycle, when it first repeats itself.
// However, when the cycle is broken up, the last repeated package is removed
// from the dependencies of the parent package.
// So we need to merge all the children of all the parent packages with same ID as the resolved package.
// This way we get all the children that were removed, when ending cycles.
function getPreviouslyResolvedChildren<T extends PartialResolvedPackage> (nodeId: string, dependenciesTree: DependenciesTree<T>) {
  const parentIds = splitNodeId(nodeId)
  const ownId = parentIds.pop()
  const allChildren = {}

  if (!ownId || !parentIds.includes(ownId)) return allChildren

  const nodeIdChunks = parentIds.join('>').split(ownId)
  nodeIdChunks.pop()
  nodeIdChunks.reduce((accNodeId, part) => {
    accNodeId += `${part}${ownId}`
    const parentNode = dependenciesTree[`${accNodeId}>`]
    Object.assign(
      allChildren,
      typeof parentNode.children === 'function' ? parentNode.children() : parentNode.children
    )
    return accNodeId
  }, '>')
  return allChildren
}

function resolvePeersOfChildren<T extends PartialResolvedPackage> (
  children: {
    [alias: string]: string
  },
  parentPkgs: ParentRefs,
  ctx: {
    pathsByNodeId: {[nodeId: string]: string}
    peersCache: PeersCache
    virtualStoreDir: string
    purePkgs: Set<string>
    depGraph: GenericDependenciesGraph<T>
    dependenciesTree: DependenciesTree<T>
    rootDir: string
    lockfileDir: string
    strictPeerDependencies: boolean
    installPeerDependencies: boolean
  }
): PeersResolution {
  const allResolvedPeers: Record<string, string> = {}
  const allMissingPeers = new Set<string>()
  const allInstallPeers = new Set<InstallPeer>()

  for (const childNodeId of Object.values(children)) {
    const { resolvedPeers, missingPeers, installPeers } = resolvePeersOfNode(childNodeId, parentPkgs, ctx)
    Object.assign(allResolvedPeers, resolvedPeers)
    missingPeers.forEach((missingPeer) => allMissingPeers.add(missingPeer))
    installPeers.forEach((installPeer) => allInstallPeers.add(installPeer))
  }

  const unknownResolvedPeersOfChildren = Object.keys(allResolvedPeers)
    .filter((alias) => !children[alias])
    .reduce((acc, peer) => {
      acc[peer] = allResolvedPeers[peer]
      return acc
    }, {})

  return { resolvedPeers: unknownResolvedPeersOfChildren, missingPeers: Array.from(allMissingPeers), installPeers: Array.from(allInstallPeers) }
}

function resolvePeers<T extends PartialResolvedPackage> (
  ctx: {
    currentDepth: number
    lockfileDir: string
    nodeId: string
    parentPkgs: ParentRefs
    resolvedPackage: T
    dependenciesTree: DependenciesTree<T>
    rootDir: string
    strictPeerDependencies: boolean
    installPeerDependencies: boolean
  }
): PeersResolution {
  const resolvedPeers: {[alias: string]: string} = {}
  const missingPeers = []
  const installPeers = {}
  for (const peerName in ctx.resolvedPackage.peerDependencies) { // eslint-disable-line:forin
    const peerVersionRange = ctx.resolvedPackage.peerDependencies[peerName]

    const resolved = ctx.parentPkgs[peerName]

    if (!resolved) {
      if (ctx.installPeerDependencies) {
        installPeers[k] = {};
        const foo = await resolveDependencies(ctx, getVersionSpecsByRealNames(installPeers), installPeers)
        // TODO resolve version -> use resolveDependencies.ts? via resolveDependencyTree.ts -> resolvedPackage
        installPeers.push({ name: peerName, versionRange: peerVersionRange })
        continue
      }
      missingPeers.push(peerName)
      if (
        ctx.resolvedPackage.peerDependenciesMeta?.[peerName]?.optional === true
      ) {
        continue
      }
      const friendlyPath = nodeIdToFriendlyPath(ctx)
      const message = `${friendlyPath ? `${friendlyPath}: ` : ''}${packageFriendlyId(ctx.resolvedPackage)} \
requires a peer of ${peerName}@${peerVersionRange} but none was installed.`
      if (ctx.strictPeerDependencies) {
        throw new PnpmError('MISSING_PEER_DEPENDENCY', message)
      }
      logger.warn({
        message,
        prefix: ctx.rootDir,
      })
      continue
    }

    if (!semver.satisfies(resolved.version, peerVersionRange, { loose: true })) {
      if (ctx.installPeerDependencies) {
        // TODO resolve version -> use resolveDependencies.ts? via resolveDependencyTree.ts -> resolvedPackage
        installPeers.push({ name: peerName, versionRange: peerVersionRange })
        continue
      }
      const friendlyPath = nodeIdToFriendlyPath(ctx)
      const message = `${friendlyPath ? `${friendlyPath}: ` : ''}${packageFriendlyId(ctx.resolvedPackage)} \
requires a peer of ${peerName}@${peerVersionRange} but version ${resolved.version} was installed.`
      if (ctx.strictPeerDependencies) {
        throw new PnpmError('INVALID_PEER_DEPENDENCY', message)
      }
      logger.warn({
        message,
        prefix: ctx.rootDir,
      })
    }

    if (resolved?.nodeId) resolvedPeers[peerName] = resolved.nodeId
  }
  return { resolvedPeers, missingPeers, installPeers }
}

function packageFriendlyId (manifest: {name: string, version: string}) {
  return `${manifest.name}@${manifest.version}`
}

function nodeIdToFriendlyPath<T extends PartialResolvedPackage> (
  {
    dependenciesTree,
    lockfileDir,
    nodeId,
    rootDir,
  }: {
    dependenciesTree: DependenciesTree<T>
    lockfileDir: string
    nodeId: string
    rootDir: string
  }
) {
  const parts = splitNodeId(nodeId).slice(0, -1)
  const result = scan((prevNodeId, pkgId) => createNodeId(prevNodeId, pkgId), '>', parts)
    .slice(2)
    .map((nid) => (dependenciesTree[nid].resolvedPackage as ResolvedPackage).name)
  const projectPath = path.relative(lockfileDir, rootDir)
  if (projectPath) {
    result.unshift(projectPath)
  }
  return result.join(' > ')
}

interface ParentRefs {
  [name: string]: ParentRef
}

interface ParentRef {
  version: string
  depth: number
  // this is null only for already installed top dependencies
  nodeId?: string
}

function toPkgByName<T extends PartialResolvedPackage> (nodes: Array<{alias: string, nodeId: string, node: DependenciesTreeNode<T>}>): ParentRefs {
  const pkgsByName: ParentRefs = {}
  for (const { alias, node, nodeId } of nodes) {
    pkgsByName[alias] = {
      depth: node.depth,
      nodeId,
      version: node.resolvedPackage.version,
    }
  }
  return pkgsByName
}

function createPeersFolderSuffix (peers: Array<{name: string, version: string}>) {
  const folderName = peers.map(({ name, version }) => `${name.replace('/', '+')}@${version}`).sort().join('+')

  // We don't want the folder name to get too long.
  // Otherwise, an ENAMETOOLONG error might happen.
  // see: https://github.com/pnpm/pnpm/issues/977
  //
  // A bigger limit might be fine but the md5 hash will be 32 symbols,
  // so for consistency's sake, we go with 32.
  if (folderName.length > 32) {
    return `_${crypto.createHash('md5').update(folderName).digest('hex')}`
  }
  return `_${folderName}`
}
