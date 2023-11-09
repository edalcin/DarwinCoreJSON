import { MongoClient } from 'https://deno.land/x/mongo@v0.31.2/mod.ts'
import { processaZip } from './lib/dwca.ts'

export const findTaxonByName = (
  obj: Record<string, { scientificName?: string }>,
  name: string
) => {
  return Object.values(obj).find(
    (taxon) => (taxon.scientificName as string).search(name) >= 0
  )
}

type FloraJson = Record<
  string,
  Record<
    string,
    string | Record<string, unknown> | Array<string | Record<string, unknown>>
  >
>
export const processaFlora = (dwcJson: FloraJson): FloraJson => {
  return Object.fromEntries(
    Object.entries(dwcJson).reduce((entries, [id, taxon]) => {
      const distribution = taxon.distribution as Record<
        string,
        Record<string, string>
      >[]
      if (
        !['ESPECIE', 'VARIEDADE', 'FORMA', 'SUB_ESPECIE'].includes(
          taxon.taxonRank as string
        )
      ) {
        return entries
      }
      if (distribution) {
        taxon.distribution = {
          origin: distribution[0]?.establishmentMeans,
          Endemism: distribution[0]?.occurrenceRemarks.endemism,
          phytogeographicDomains:
            distribution[0]?.occurrenceRemarks.phytogeographicDomain,
          occurrence: distribution.map(({ locationID }) => locationID).sort(),
          vegetationType: (
            taxon.speciesprofile as Record<string, Record<string, string>>[]
          )?.[0]?.lifeForm?.vegetationType
        }
      }
      if (taxon.resourcerelationship) {
        const resourcerelationship = taxon.resourcerelationship as Record<
          string,
          string | Record<string, string>
        >[]
        taxon.othernames = resourcerelationship.map((relationship) => ({
          taxonID: relationship.relatedResourceID,
          scientificName:
            dwcJson[relationship.relatedResourceID as string]?.scientificName,
          taxonomicStatus: relationship.relationshipOfResource
        }))
        delete taxon.resourcerelationship
      }

      if (taxon.speciesprofile) {
        taxon.speciesprofile = (
          taxon.speciesprofile as Record<string, unknown>[]
        )[0]
        delete (taxon.speciesprofile.lifeForm as Record<string, unknown>)
          .vegetationType
      }

      if (taxon.higherClassification) {
        // Usa somente segundo componente da string separada por ;
        // https://github.com/edalcin/DarwinCoreJSON/issues/13
        taxon.higherClassification = (
          taxon.higherClassification as string
        ).split(';')[1]
      }

      entries.push([id, taxon])
      return entries
    }, [] as [string, FloraJson[string]][])
  )
}

export const processaFloraZip = async (url: string) => {
  const json = await processaZip(url)
  const floraJson = processaFlora(json)
  return floraJson
}
async function main() {
  if (Deno.args?.length === 0) {
    return
  }
  const [url] = Deno.args
  const json = await processaFloraZip(url)
  const client = new MongoClient()
  await client.connect(Deno.env.get('MONGO_URI') as string)
  const collection = client.database('dwc2json').collection('taxa')
  console.debug('Cleaning collection')
  console.log(await collection.deleteMany({}))
  console.debug('Inserting taxa')
  const taxa = Object.values(json)
  for (let i = 0, n = taxa.length; i < n; i += 5000) {
    console.log(`Inserting ${i} to ${Math.min(i + 5000, n)}`)
    await collection.insertMany(taxa.slice(i, i + 5000), { ordered: false })
  }
  console.log('Creating indexes')
  await collection.createIndexes({
    indexes: [
      {
        key: { scientificName: 1 },
        name: 'scientificName'
      }
    ]
  })
  console.debug('Done')
}

main()