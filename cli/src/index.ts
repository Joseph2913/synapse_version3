#!/usr/bin/env node
import { Command } from 'commander'
import * as queryCmd from './commands/query.js'
import * as searchCmd from './commands/search.js'
import * as entityCmd from './commands/entity.js'
import * as connectionsCmd from './commands/connections.js'
import * as anchorsCmd from './commands/anchors.js'
import * as sourcesCmd from './commands/sources.js'
import * as sendCmd from './commands/send.js'
import * as configCmd from './commands/config.js'

const program = new Command()
  .name('synapse')
  .description('Personal knowledge graph CLI — query and manage your Synapse graph from the terminal')
  .version('1.0.0')

// Config commands
const configCmd_ = program
  .command('config')
  .description('Manage configuration')

configCmd_
  .command('init')
  .description('Initialize or update Synapse configuration')
  .action(() => configCmd.init())

configCmd_
  .command('show')
  .description('Display current configuration (with masked API key)')
  .action(() => configCmd.show())

configCmd_
  .command('set <key> <value>')
  .description('Set a configuration value')
  .action((key: string, value: string) => configCmd.set(key, value))

configCmd_
  .command('delete-key')
  .description('Remove the stored API key')
  .action(() => configCmd.deleteKey())

// Query command
program
  .command('ask <question>')
  .description('Ask your knowledge graph a question')
  .option('--limit <n>', 'Maximum results (default: 10)', '10')
  .option('--sources-only', 'Return only sources')
  .action((question: string, options: any) => {
    queryCmd.ask(question, {
      limit: parseInt(options.limit),
      sourcesOnly: options.sourcesOnly,
    })
  })

// Search commands
const searchCmd_ = program
  .command('search')
  .description('Search your knowledge graph')

searchCmd_
  .command('entities <query>')
  .description('Search for entities by name or description')
  .option('--type <type>', 'Filter by entity type')
  .option('--limit <n>', 'Maximum results (default: 10)', '10')
  .option('--source-id <id>', 'Filter by source ID')
  .action((query: string, options: any) => {
    searchCmd.searchEntities(query, {
      type: options.type,
      limit: parseInt(options.limit),
      sourceId: options.sourceId,
    })
  })

// Entity detail
program
  .command('get entity <label>')
  .description('Get detailed information about an entity')
  .action((label: string) => {
    entityCmd.getEntity(label)
  })

// Connections
program
  .command('connections <label>')
  .description('Traverse connections around an entity')
  .option('--hops <n>', 'Number of hops (1-3, default: 2)', '2')
  .action((label: string, options: any) => {
    connectionsCmd.getConnections(label, {
      hops: parseInt(options.hops),
    })
  })

// Anchors
program
  .command('list anchors')
  .description('List all anchor entities in your knowledge graph')
  .action(() => {
    anchorsCmd.listAnchors()
  })

// Sources
program
  .command('sources')
  .description('List recent sources')
  .option('--type <type>', 'Filter by source type (Meeting, YouTube, Document, Note, etc.)')
  .option('--recent <n>', 'Number of recent sources (default: 10)', '10')
  .option('--from <date>', 'ISO date string')
  .option('--to <date>', 'ISO date string')
  .option('--participant <name>', 'Filter by participant name')
  .action((options: any) => {
    sourcesCmd.getSources({
      type: options.type,
      recent: parseInt(options.recent),
      from: options.from,
      to: options.to,
      participant: options.participant,
    })
  })

// Read source
program
  .command('read <sourceId>')
  .description('Read full content of a source by ID')
  .action((sourceId: string) => {
    sourcesCmd.readSource(sourceId)
  })

searchCmd_
  .command('sources <query>')
  .description('Search for sources by title or content')
  .option('--type <type>', 'Filter by source type')
  .option('--limit <n>', 'Maximum results (default: 10)', '10')
  .action((query: string, options: any) => {
    searchCmd.searchSources(query, {
      type: options.type,
      limit: parseInt(options.limit),
    })
  })

// Send to graph
program
  .command('send <title> [content]')
  .description('Send new content to your knowledge graph')
  .option('--from-file <path>', 'Read content from a file')
  .option('--repo <name>', 'Repository name')
  .option('--branch <name>', 'Branch name')
  .option('--guidance <text>', 'Custom guidance for extraction')
  .action((title: string, content: string | undefined, options: any) => {
    sendCmd.send(title, content, {
      fromFile: options.fromFile,
      repo: options.repo,
      branch: options.branch,
      guidance: options.guidance,
    })
  })

// Help text
program.on('--help', () => {
  console.log('')
  console.log('Examples:')
  console.log('')
  console.log('  $ synapse config init')
  console.log('  $ synapse ask "what is my top anchor?"')
  console.log('  $ synapse search entities "kubernetes" --type Technology')
  console.log('  $ synapse connections "Machine Learning" --hops 2')
  console.log('  $ synapse sources --type Meeting --recent 5')
  console.log('  $ synapse send "Meeting notes" "discussed X and Y"')
  console.log('')
})

program.parse(process.argv)

if (!process.argv.slice(2).length) {
  program.outputHelp()
}
