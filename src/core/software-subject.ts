export interface SoftwareSubject {
  name: string
  repository: string
  commit: string
  url: string
}

export type SoftwareRole = 'instrument' | 'introduction'

export function isSoftwareRole(value: unknown): value is SoftwareRole {
  return value === 'instrument' || value === 'introduction'
}

export const SOFTWARE_ROLE_HINT = 'Choose how this paper will use the software.'

export function softwareSubject(link: string): SoftwareSubject | null {
  const match = /^https:\/\/github\.com\/([a-z0-9][a-z0-9-]*)\/([a-z0-9_.-]+)\/commit\/([a-f0-9]{40})\/?$/i.exec(link.trim())
  if (!match || match[2] === '.' || match[2] === '..') return null
  const name = `${match[1]}/${match[2]}`
  const repository = `https://github.com/${name}`
  const commit = match[3].toLowerCase()
  return { name, repository, commit, url: `${repository}/commit/${commit}` }
}

export const SOFTWARE_SUBJECT_HINT = 'Use a GitHub commit link with the full commit SHA.'

/** A single commit in the seed can be reviewed and removed in Materials. */
export function softwareSubjectFromSeed(seed: string): SoftwareSubject | null {
  const links = seed.match(/https:\/\/github\.com\/[^\s<>"'`)\]]+/gi) ?? []
  const matches = new Map<string, SoftwareSubject>()
  for (const link of links) {
    const subject = softwareSubject(link.replace(/[.,;!?]+$/, ''))
    if (subject) matches.set(subject.url.toLowerCase(), subject)
  }
  return matches.size === 1 ? [...matches.values()][0] : null
}
