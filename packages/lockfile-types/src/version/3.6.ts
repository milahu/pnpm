import { DependenciesMeta } from '@pnpm/types'

export const lockfileVersion = 3.6;
export const lockfileName = 'shrinkwrap.yaml';

export interface Lockfile {
  dependencies?: ResolvedDependencies
  optionalDependencies?: ResolvedDependencies
  devDependencies?: ResolvedDependencies
  dependenciesMeta?: DependenciesMeta
  packages?: PackageSnapshots
  registry?: string
  shrinkwrapMinorVersion?: number
  shrinkwrapVersion: number
  specifiers: ResolvedDependencies
}

export interface ProjectSnapshot {
}

export interface PackageSnapshots {
  [packagePath: string]: PackageSnapshot
}

/**
 * tarball hosted remotely
 */
export interface TarballResolution {
  type?: undefined
  tarball: string
  integrity?: string
  // needed in some cases to get the auth token
  // sometimes the tarball URL is under a different path
  // and the auth token is specified for the registry only
  registry?: string
}

/**
 * directory on a file system
 */
export interface DirectoryResolution {
  type: 'directory'
  directory: string
}

/**
 * Git repository
 */
export interface GitRepositoryResolution {
  type: 'git'
  repo: string
  commit: string
}

export type Resolution =
  TarballResolution |
  GitRepositoryResolution |
  DirectoryResolution

export type LockfileResolution = Resolution | {
  integrity: string
  registry?: string
}

export interface PackageSnapshot {
  id?: string
  dev?: true | false
  optional?: true
  requiresBuild?: true
  prepare?: true
  hasBin?: true
  // name and version are only needed
  // for packages that are hosted not in the npm registry
  name?: string
  version?: string
  resolution: LockfileResolution
  dependencies?: ResolvedDependencies
  optionalDependencies?: ResolvedDependencies
  peerDependencies?: {
    [name: string]: string
  }
  peerDependenciesMeta?: {
    [name: string]: {
      optional: true
    }
  }
  transitivePeerDependencies?: string[]
  bundledDependencies?: string[]
  engines?: string[] | {
    node?: string;
    npm?: string;
  } | {
    // https://github.com/pnpm/pnpm/issues/4518
    // bug: engines array is stored as object
    [index: string]: string;
  };
  os?: string[]
  cpu?: string[]
  deprecated?: string
}

export interface Dependencies {
  [name: string]: string
}

export type PackageBin = string | {[name: string]: string}

/** @example
 * {
 *   "foo": "registry.npmjs.org/foo/1.0.1"
 * }
 */
export interface ResolvedDependencies {
  [depName: string]: string
}
