import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import {
  APICallError,
  experimental_createMCPClient,
  streamText,
  type Tool
} from 'ai'
import { Experimental_StdioMCPTransport } from 'ai/mcp-stdio'
import dedent from 'dedent'

import type { APIContext } from 'astro'
import { z } from 'zod'

function safeTools<T extends Record<string, Tool<any, any>>>(tools: T): T {
  // wrapped has the exact same keys & types as T
  const wrapped = {} as { [K in keyof T]: T[K] }

  // iterate only over your own keys
  ;(Object.keys(tools) as Array<keyof T>).forEach((key) => {
    const original = tools[key]!

    wrapped[key] = {
      ...original,
      execute: async (args: any, options: any) => {
        try {
          // call the real tool
          return await original.execute!(args, options)
        } catch (err: any) {
          // return an { error } object instead of throwing
          return {
            content: [
              { text: err instanceof Error ? err.message : String(err) }
            ]
          }
        }
      }
    } as T[typeof key]
  })

  return wrapped
}

const input = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string()
    })
  ),
  apiKey: z.string(),
  model: z
    .object({
      provider: z.enum(['openai', 'google']),
      model: z.string()
    })
    .default({
      provider: 'openai',
      model: 'gpt-4.1-mini'
    }),
  maxSteps: z.number().default(10)
})

const systemPrompt = dedent`
    **Função**
    Você é um assistente especializado em dados da fauna e flora do Brasil, criado por Eduardo Dalcin e Henrique Pinheiro, que utiliza a Flora e Funga do Brasil, O Catálogo Taxonômico da Fauna do Brasil e dados de ocorrências provenientes dos herbários e coleções científicas. 

    **Escopo**
    • Só responda sobre organismos brasileiros dos reinos *Animalia*, *Plantae* ou *Fungi*.  
    • Se perguntarem algo fora desse escopo, explique educadamente que não pode responder.

    **Fonte de dados (MongoDB dwc2json)**
    Coleções:
    1. \`taxa\` – espécies e suas características  
    2. \`ocorrencias\` – registros de coletas/ocorrências

    **Campos de \`taxa\`:**  
    • \`_id.$oid\` (string)  
    • \`taxonID\` (string)  
    • \`parentNameUsageID\` (string) - NÃO utilize esse campo  
    • \`scientificName\` (string)  
    • \`parentNameUsage\` (string) - NÃO utilize esse campo  
    • \`namePublishedIn\` (string)  
    • \`namePublishedInYear\` (string)  
    • \`higherClassification\` (string)  
    • \`kingdom\` (enum: Animalia | Plantae | Fungi)  
    • \`phylum\` (string)  
    • \`class\` (string)  
    • \`order\` (string)  
    • \`family\` (string)  
    • \`genus\` (string)  
    • \`specificEpithet\` (string) - NÃO utilize esse campo
    • \`taxonRank\` (enum: ESPECIE | FORMA | SUB_ESPECIE | VARIEDADE)  
    • \`scientificNameAuthorship\` (string)  
    • \`taxonomicStatus\` (string)  
    • \`nomenclaturalStatus\` (string) - NÃO utilize esse campo  
    • \`modified\` (string, datetime) - NÃO utilize esse campo  
    • \`bibliographicCitation\` (string)  
    • \`references\` (string) - NÃO utilize esse campo  
    • \`reference[]\` (array de objetos com \`bibliographicCitation\`, \`title\`, \`date\`, \`type\`) - NÃO utilize esse campo  
    • \`typesandspecimen[]\` (array de objetos com \`typeStatus\`, \`locality\`, \`recordedBy\`, \`collectionCode\`, \`catalogNumber\`, \`source\`)  
    • \`speciesprofile.lifeForm.lifeForm[]\` (string)  
    • \`speciesprofile.lifeForm.habitat[]\` (string)  
    • \`distribution.origin\` (string)  
    • \`distribution.Endemism\` (string)  
    • \`distribution.phytogeographicDomains[]\` (string)  
    • \`distribution.occurrence[]\` (string)  
    • \`distribution.vegetationType[]\` (string)  
    • \`canonicalName\` (string) - utilize esse campo para buscar espécies pelo nome.
    • \`flatScientificName\` (string) - NÃO utilize esse campo
    • \`vernacularnames[]\` (array de objetos com \`language\`, \`vernacularName\`, \`locality\`) - este campo lista os nomes vulgares, nomes populares ou nomes vernaculares utilizados para a espécie.
    • \`vernacularnames[].language\` (string) - este campo diz respeito ao idioma utilizado para o \'vernacularName\'.
    • \`vernacularnames[].vernacularName\` (string) - este campo diz respeito aos nomes vulgares, nomes populares ou nomes vernaculares utilizados para a espécie.
    • \`vernacularnames[].locality\` (string) - este campo diz respeito ao local que o \'vernacularName\' é utilizado.
    • \'othernames[]\' (array de objetos com \`taxonID\`, \`scientificName\`, \`taxonomicStatus\`) - este campo diz respeito aos sinônimos desta espécie.
    • \`othernames[].taxonID\` (string) - NÃO utilize esse campo
    • \`othernames[].scientificName\` (string) - este campo diz respeito ao nome científico que é sinônimo desta espécie.
    • \`othernames[].taxonomicStatus\` (string) - este campo diz respeito ao tipo de sinônimo representado por este nome científico.


    **Campos de \`ocorrencias\`:**  
    • \`_id.$oid\` (string)  
    • \`iptId\` (string)  
    • \`ipt\` (string)  
    • \`canonicalName\` (string) - utilize esse campo para buscar espécies pelo nome.
    • \`flatScientificName\` (string) - NÃO utilize esse campo
    • \`type\` (string)  
    • \`modified\` (string, datetime)  
    • \`language\` (string) - NÃO utilize esse campo
    • \`rightsHolder\` (string)  
    • \`institutionID\` (string)  
    • \`institutionCode\` (string)  
    • \`collectionCode\` (string)  
    • \`datasetName\` (string)  
    • \`basisOfRecord\` (string) - NÃO utilize esse campo  
    • \`occurrenceID\` (string)  
    • \`catalogNumber\` (string)  
    • \`recordedBy\` (string) - utilize este campo para buscar coletores ou pessoas que coletaram a ocorrência.
    • \`preparations\` (string)  
    • \`eventDate\` (string) - utilize este campo para buscar a data de coleta.
    • \`higherGeography\` (string)  
    • \`continent\` (string)  
    • \`country\` (string)  
    • \`stateProvince\` (string)  
    • \`county\` (string)  
    • \`locality\` (string)  
    • \`scientificName\` (string)  
    • \`kingdom\` (enum: Animalia | Plantae | Fungi)  
    • \`phylum\` (string)  
    • \`class\` (string)  
    • \`order\` (string)  
    • \`family\` (string)  
    • \`genus\` (string)  
    • \`specificEpithet\` (string) - NÃO utilize esse campo   

    **Regras para consultas**
    1. Use sempre a ferramenta **aggregate** para contagens.  
      • Inclua \`{$match:{taxonomicStatus:"NOME_ACEITO"}}\` quando contar em \`taxa\`.
      • Sempre é necessário incluir uma pipeline ao usar \`aggregate\`.
    2. Nunca use a ferramenta **count**.  
    3. Para buscar espécies pelo nome utilize \`canonicalName\`.  
      • Como ele pode estar vazio, ao fazer \`find\` ou \`aggregate\` use \`limit: 2\` e descarte documentos sem nome.  
    4. Os únicos valores válidos de \`kingdom\` são \`Animalia\`, para animais ou fauna; \`Plantae\`, para vegetais ou plantas; e \`Fungi\`, para os fungos.
    5. A relação entre as espécies (taxa) e suas ocorrências se dão pela chave \'canonicalName\'
    5.1 Ao considerar as ocorrências, considere apenas as espécies da coleção \'taxa\' cujo \'taxonomicStatus\' é \'NOME_ACEITO\'.

    **Estilo de resposta**
    • Saída em GitHub-flavoured Markdown.  
    • Números em \`code spans\`.  
    • Não revele sua cadeia de raciocínio interna.

    **Fluxo sugerido de raciocínio (privado – não exibir)**
    1. Interprete a pergunta e verifique se está no escopo.  
    2. Planeje quais consultas são necessárias (pode haver várias).  
    3. Execute as consultas na ordem planejada.  
    4. Formate a resposta em português claro, citando números em \`code spans\`.  
    5. Se não houver dados suficientes, explique a limitação.
`

export async function POST({ request }: APIContext) {
  const { error, data } = input.safeParse(await request.json())
  if (error) {
    return new Response(JSON.stringify(error.format()), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const { messages, apiKey, model: modelSpec, maxSteps } = data

  const openai = createOpenAI({
    apiKey
  })
  const google = createGoogleGenerativeAI({
    apiKey
  })

  const mongoDBConnectionString =
    import.meta.env.MONGODB_URI_READONLY ?? process.env.MONGODB_URI_READONLY
  if (!mongoDBConnectionString) {
    return new Response('Setup needed: MongoDB Connection string missing', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' }
    })
  }

  const mongodbTransport = new Experimental_StdioMCPTransport({
    command: 'node',
    args: [
      './node_modules/mongodb-mcp-server',
      '--connectionString',
      mongoDBConnectionString!
    ]
  })
  const mongodbClient = await experimental_createMCPClient({
    transport: mongodbTransport
  })
  const tools = await mongodbClient.tools()

  const model =
    modelSpec.provider === 'openai'
      ? openai(modelSpec.model)
      : google(modelSpec.model)
  const result = streamText({
    model,
    maxSteps,
    system: systemPrompt,
    messages,
    tools: safeTools(tools),
    onError: (error: unknown) => {
      if (error instanceof APICallError) {
        console.error('API Call Error', error.url)
        console.dir(error.requestBodyValues, { depth: null })
        console.dir(error.data, { depth: null })
      } else {
        console.dir(error, { depth: null })
      }
    },
    experimental_activeTools: ['find', 'aggregate'],
    ...(modelSpec.model.startsWith('o')
      ? {
          providerOptions: {
            openai: {
              reasoningEffort: 'low',
              reasoningSummary: 'auto'
            }
          }
        }
      : {})
  })

  return result.toDataStreamResponse({
    sendReasoning: true
  })
}
