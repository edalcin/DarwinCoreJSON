import { type Collection, MongoClient } from 'mongodb'

const url =
  // @ts-ignore astro stuff
  import.meta.env.MONGO_URI ??
  // @ts-ignore ignore node stuff
  process.env.MONGO_URI
if (!url) {
  throw new Error(
    'Please define the MONGO_URI environment variable inside .env.local'
  )
}
const client = new MongoClient(url)

function connectClientWithTimeout(timeout = 5000) {
  return new Promise((resolve) => {
    const timeoutTimer = setTimeout(() => {
      resolve(false)
    }, timeout)
    client
      .connect()
      .then(
        () => {
          resolve(true)
        },
        () => {
          resolve(false)
        }
      )
      .finally(() => {
        clearTimeout(timeoutTimer)
      })
  })
}

async function getCollection(dbName: string, collection: string) {
  if (!(await connectClientWithTimeout())) {
    return null
  }
  return client.db(dbName).collection(collection) as Collection
}

export async function listTaxa(
  filter: Record<string, unknown> = {},
  _projection: Record<string, unknown> = {}
) {
  const taxa = await getCollection('dwc2json', 'taxa')
  if (!taxa) return null
  return await taxa
    .find(filter)
    // .project(projection)
    .sort({ scientificName: 1 })
    .toArray()
}

export async function listOccurrences(
  filter: Record<string, unknown> = {},
  _projection: Record<string, unknown> = {}
) {
  const occurrences = await getCollection('dwc2json', 'ocorrencias')
  if (!occurrences) return null
  return await occurrences
    .find(filter)
    // .project(projection)
    .toArray()
}

export async function listTaxaPaginated(
  filter: Record<string, unknown> = {},
  page = 0,
  _projection: Record<string, unknown> = {}
) {
  const taxa = await getCollection('dwc2json', 'taxa')
  if (!taxa) return null
  const total = await taxa.countDocuments(filter)
  const totalPages = Math.ceil(total / 50)
  const data = await taxa
    .find(filter)
    // .project(projection)
    .sort({ scientificName: 1 })
    .skip(page * 50)
    .limit(50)
    .toArray()
  return {
    data,
    total,
    totalPages
  }
}

export async function countTaxa(filter: Record<string, unknown> = {}) {
  const taxa = await getCollection('dwc2json', 'taxa')
  if (!taxa) return null
  return await taxa.countDocuments(filter)
}

export interface TaxaFilter {
  [key: string]: string | RegExp
}

export async function countTaxaRegions(filter: TaxaFilter = {}) {
  const taxa = await getCollection('dwc2json', 'taxa')
  if (!taxa) return null

  const matchStage: Record<string, unknown> = {
    taxonomicStatus: /NOME[_ ]ACEITO/
  }

  // Add all filters as case-insensitive regex
  Object.entries(filter).forEach(([key, value]) => {
    if (value) {
      if (key === 'genus' || key === 'specificEpithet') {
        matchStage[key] =
          value instanceof RegExp ? value : new RegExp(`^${value.trim()}$`, 'i')
      } else {
        matchStage[key] =
          value instanceof RegExp
            ? value
            : new RegExp(`\\b${value.trim()}\\b`, 'i')
      }
    }
  })

  const [result] = await taxa
    .aggregate([
      {
        $match: matchStage
      },
      {
        $facet: {
          total: [
            {
              $count: 'count'
            }
          ],
          byRegion: [
            {
              $unwind: {
                path: '$distribution.occurrence'
              }
            },
            {
              $group: {
                _id: '$distribution.occurrence',
                count: {
                  $count: {}
                }
              }
            }
          ]
        }
      }
    ])
    .toArray()

  if (!result) {
    return {
      total: 0,
      regions: []
    }
  }

  return {
    total: result.total[0]?.count || 0,
    regions: result.byRegion
  }
}

export async function getTaxonomicStatusPerKingdom(kingdom: string) {
  const taxa = await getCollection('dwc2json', 'taxa')
  if (!taxa) return null
  return await taxa
    .aggregate([
      {
        $match: {
          kingdom: kingdom[0]!.toUpperCase() + kingdom.slice(1).toLowerCase()
        }
      },
      {
        $group: {
          _id: {
            $ifNull: ['$taxonomicStatus', '$nomenclaturalStatus']
          },
          count: {
            $count: {}
          }
        }
      }
    ])
    .toArray()
}

export async function getFamilyPerKingdom(kingdom: string) {
  const taxa = await getCollection('dwc2json', 'taxa')
  if (!taxa) return null
  return await taxa
    .aggregate([
      {
        $match: {
          kingdom: kingdom[0]!.toUpperCase() + kingdom.slice(1).toLowerCase(),
          taxonomicStatus: 'NOME_ACEITO',
          taxonRank: 'ESPECIE'
        }
      },
      {
        $addFields: {
          family: {
            $cond: {
              if: { $eq: ['$higherClassification', 'Algas'] },
              then: { $concat: ['[Algae]: ', '$class'] },
              else: '$family'
            }
          }
        }
      },
      {
        $group: {
          // _id: kingdom.toLocaleLowerCase() === 'fungi' ? '$phylum' : '$family',
          _id: '$family',
          count: {
            $count: {}
          }
        }
      }
    ])
    .toArray()
}

export async function getTaxon(
  kingdom: 'Plantae' | 'Fungi' | 'Animalia',
  id: string,
  includeOccurrences = false
) {
  const taxa = await getCollection('dwc2json', 'taxa')
  if (!taxa) return null
  return includeOccurrences
    ? (
        await taxa
          .aggregate([
            {
              $match: {
                kingdom,
                taxonID: id
              }
            },
            {
              $lookup: {
                from: 'ocorrencias',
                localField: 'scientificName',
                foreignField: 'scientificName',
                as: 'occurrences'
              }
            }
          ])
          .toArray()
      )[0]
    : await taxa.findOne({ kingdom, taxonID: id })
}
