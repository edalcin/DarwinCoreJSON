import { parse } from 'https://deno.land/x/xml@2.1.0/mod.ts'
import { unZipFromURL } from 'https://deno.land/x/zip@v1.1.0/mod.ts'
import { MongoClient } from 'https://deno.land/x/mongo@v0.31.2/mod.ts'

type WithAttribute<A extends string, T> = {
  [key in `@${A}`]: T
}
type IndexedField = WithAttribute<'index', number>
type IndexedFieldWithTerm = IndexedField & WithAttribute<'term', string>
type BaseSpec = {
  files: {
    location: string
  }
  field: IndexedFieldWithTerm[]
}
type CoreSpec = BaseSpec & {
  id: IndexedField
}
type ExtensionSpec = BaseSpec & {
  id: undefined
  coreid: IndexedField
}
type DwcJson = Record<
  string,
  Record<string, string | Record<string, unknown>[]>
>

const _parseJsonEntry = (entry: CoreSpec | ExtensionSpec) => {
  const fields = []
  fields[(entry.id ?? entry.coreid)['@index']] = 'INDEX'
  entry.field.forEach((field) => {
    fields[field['@index']] = field['@term'].split('/').pop()
  })
  return { file: entry.files.location, fields }
}

const streamProcessor = async (
  fileName: string,
  lineCallback: (line: string) => void
) => {
  const file = await Deno.open(fileName, { read: true })
  const decoder = new TextDecoder()
  let lineRemainder = ''
  let skippedFirstLine = false
  for await (const chunk of file.readable) {
    const lines = decoder.decode(chunk).split('\n')
    const lastLine = lines.pop()
    lines[0] = lineRemainder + lines[0]
    for (const line of lines) {
      if (skippedFirstLine) {
        lineCallback(line)
      } else {
        skippedFirstLine = true
      }
    }
    lineRemainder = lastLine ?? ''
  }
  if (lineRemainder) {
    lineCallback(lineRemainder)
  }
}

const _addLineToObj = (line: string, fields: string[], obj: DwcJson) => {
  const values = line.split('\t')
  const id = values[fields.indexOf('INDEX')]
  if (id) {
    obj[id] = {}
    fields.forEach((field, index) => {
      if (field !== 'INDEX' && values[index]) {
        obj[id][field] = values[index]
      }
    })
  }
}
const getFileFields = async (fileName: string, fields: string[]) => {
  const obj: DwcJson = {}
  await streamProcessor(fileName, (line) => {
    _addLineToObj(line, fields, obj)
  })
  return obj
}

const jsonSafeParse = (str: string) => {
  try {
    return JSON.parse(str)
  } catch (_e) {
    return str
  }
}

const addExtension = async (
  obj: DwcJson,
  filePath: string,
  fields: string[]
) => {
  const extensionName = filePath.split('/').pop()?.split('.').shift() as string
  await streamProcessor(filePath, (line) => {
    const values = line.split('\t')
    const id = values[fields.indexOf('INDEX')]
    if (values.slice(1).every((v) => !v)) {
      return
    }
    if (!obj[id][extensionName]) {
      obj[id][extensionName] = []
    }
    ;(obj[id][extensionName] as Record<string, unknown>[]).push(
      fields.reduce((acc, field, index) => {
        if (field !== 'INDEX' && values[index]) {
          acc[field] =
            values[index].charAt(0) === '{'
              ? jsonSafeParse(values[index])
              : values[index]
        }
        return acc
      }, {} as Record<string, unknown>)
    )
  })
}

export const buildJson = async (folder: string) => {
  const contents = await Deno.readTextFile(`${folder}/meta.xml`)
  const { archive } = parse(contents) as unknown as {
    archive: { core: CoreSpec; extension: ExtensionSpec[] }
  }
  const ref = {
    core: _parseJsonEntry(archive.core),
    extensions: archive.extension.map(_parseJsonEntry)
  }
  const root = await getFileFields(
    `${folder}/${ref.core.file}`,
    ref.core.fields
  )
  for (const extension of ref.extensions) {
    await addExtension(root, `${folder}/${extension.file}`, extension.fields)
  }
  return root
}

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

export const processaZip = async (url: string) => {
  await unZipFromURL(url, '.temp')
  const json = await buildJson('.temp')
  await Deno.remove('.temp', { recursive: true })
  return json
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
        key: { scientificName: 'text' },
        name: 'scientificName'
      }
    ]
  })
  console.debug('Done')
}

main()
