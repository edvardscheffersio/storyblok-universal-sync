const chalk = require('chalk')
const StoryblokClient = require('storyblok-js-client')
const pSeries = require('p-series')

const SyncSpaces = {
  targetComponents: [],
  sourceComponents: [],

  init (options) {
    console.log(chalk.green('✓') + ' Loading options')
    this.sourceSpaceId = options.sourceSpaceId
    this.targetSpaceId = options.targetSpaceId
    this.sourceClient = options.sourceClient
	this.targetClient = options.targetClient
  },

  async syncStories () {
    console.log(chalk.green('✓') + ' Syncing stories...')
    var targetFolders = await this.targetClient.getAll(`spaces/${this.targetSpaceId}/stories`, {
      folder_only: 1,
      sort_by: 'slug:asc'
    })

    var folderMapping = {}

    for (let i = 0; i < targetFolders.length; i++) {
      var folder = targetFolders[i]
      folderMapping[folder.full_slug] = folder.id
    }

    var all = await this.sourceClient.getAll(`spaces/${this.sourceSpaceId}/stories`, {
      story_only: 1
    })

    for (let i = 0; i < all.length; i++) {
      console.log(chalk.green('✓') + ' Starting update ' + all[i].full_slug)

      var storyResult = await this.sourceClient.get('spaces/' + this.sourceSpaceId + '/stories/' + all[i].id)
      var sourceStory = storyResult.data.story
      var slugs = sourceStory.full_slug.split('/')
      var folderId = 0

      if (slugs.length > 1) {
        slugs.pop()
        var folderSlug = slugs.join('/')

        if (folderMapping[folderSlug]) {
          folderId = folderMapping[folderSlug]
        } else {
          console.error(chalk.red('X') + 'The folder does not exist ' + folderSlug)
          continue
        }
      }

      sourceStory.parent_id = folderId

      try {
        var existingStory = await this.targetClient.get('spaces/' + this.targetSpaceId + '/stories', { with_slug: all[i].full_slug })
        var payload = {
          story: sourceStory,
          force_update: '1'
        }
        if (sourceStory.published) {
          payload.publish = '1'
        }

        if (existingStory.data.stories.length === 1) {
          await this.targetClient.put('spaces/' + this.targetSpaceId + '/stories/' + existingStory.data.stories[0].id, payload)
          console.log(chalk.green('✓') + ' Updated ' + existingStory.data.stories[0].full_slug)
        } else {
          await this.targetClient.post('spaces/' + this.targetSpaceId + '/stories', payload)
          console.log(chalk.green('✓') + ' Created ' + sourceStory.full_slug)
        }
      } catch (e) {
        console.log(e)
      }
    }

    return Promise.resolve(all)
  },

  async syncFolders () {
    console.log(chalk.green('✓') + ' Syncing folders...')
    const sourceFolders = await this.sourceClient.getAll(`spaces/${this.sourceSpaceId}/stories`, {
      folder_only: 1,
      sort_by: 'slug:asc'
    })
    const syncedFolders = {}

    for (var i = 0; i < sourceFolders.length; i++) {
      const folder = sourceFolders[i]
      const folderId = folder.id
      delete folder.id
      delete folder.created_at

      if (folder.parent_id) {
        // Parent child resolving
        if (!syncedFolders[folderId]) {
          const folderSlug = folder.full_slug.split('/')
          const parentFolderSlug = folderSlug.splice(0, folderSlug.length - 1).join('/')

          const existingFolders = await this.targetClient.get(`spaces/${this.targetSpaceId}/stories`, {
            with_slug: parentFolderSlug
          })

          if (existingFolders.data.stories.length) {
            folder.parent_id = existingFolders.data.stories[0].id
          } else {
            folder.parent_id = 0
          }
        } else {
          folder.parent_id = syncedFolders[folderId]
        }
      }

      try {
        const newFolder = await this.targetClient.post(`spaces/${this.targetSpaceId}/stories`, {
          story: folder
        })

        syncedFolders[folderId] = newFolder.data.story.id
        console.log(`Folder ${newFolder.data.story.name} created`)
      } catch (e) {
        console.log(`Folder ${folder.name} not created. It may exists already. (${e.message})`)
      }
    }
  },

  async syncRoles () {
    console.log(chalk.green('✓') + ' Syncing roles...')
    const existingFolders = await this.targetClient.getAll(`spaces/${this.targetSpaceId}/stories`, {
      folder_only: 1,
      sort_by: 'slug:asc'
    })

    const roles = await this.sourceClient.get(`spaces/${this.sourceSpaceId}/space_roles`)
    const existingRoles = await this.targetClient.get(`spaces/${this.targetSpaceId}/space_roles`)

    for (var i = 0; i < roles.data.space_roles.length; i++) {
      const spaceRole = roles.data.space_roles[i]
      delete spaceRole.id
      delete spaceRole.created_at

      spaceRole.allowed_paths = []

      spaceRole.resolved_allowed_paths.forEach((path) => {
        const folders = existingFolders.filter((story) => {
          return story.full_slug + '/' === path
        })

        if (folders.length) {
          spaceRole.allowed_paths.push(folders[0].id)
        }
      })

      const existingRole = existingRoles.data.space_roles.filter((role) => {
        return role.role === spaceRole.role
      })
      if (existingRole.length) {
        await this.targetClient.put(`spaces/${this.targetSpaceId}/space_roles/${existingRole[0].id}`, {
          space_role: spaceRole
        })
      } else {
        await this.targetClient.post(`spaces/${this.targetSpaceId}/space_roles`, {
          space_role: spaceRole
        })
      }
      console.log(chalk.green('✓') + ` Role ${spaceRole.role} synced`)
    }
  },

  async syncComponents () {
    console.log(chalk.green('✓') + ' Syncing components...')
    this.targetComponents = await this.targetClient.get(`spaces/${this.targetSpaceId}/components`)
    this.sourceComponents = await this.sourceClient.get(`spaces/${this.sourceSpaceId}/components`)

    for (var i = 0; i < this.sourceComponents.data.components.length; i++) {
      const component = this.sourceComponents.data.components[i]

      delete component.id
      delete component.created_at

      // Create new component on target space
      try {
        await this.targetClient.post(`spaces/${this.targetSpaceId}/components`, {
          component: component
        })
        console.log(chalk.green('✓') + ` Component ${component.name} synced`)
      } catch (e) {
        if (e.response.status === 422) {
          await this.targetClient.put(`spaces/${this.targetSpaceId}/components/${this.getTargetComponentId(component.name)}`, {
            component: component
          })
          console.log(chalk.green('✓') + ` Component ${component.name} synced`)
        } else {
          console.error(chalk.red('X') + ` Component ${component.name} sync failed`)
        }
      }
    }
  },

  getTargetComponentId (name) {
    const comps = this.targetComponents.data.components.filter((comp) => {
      return comp.name === name
    })

    return comps[0].id
  }
}

/**
 * @method sync
 * @param  {Array} types
 * @param  {*} options      { token: String, source: Number, target: Number, api: String }
 * @return {Promise}
 */
const sync = (types, options) => {
  SyncSpaces.init(options)

  const tasks = types.map(_type => {
    const command = `sync${_type}`
    return () => SyncSpaces[command]()
  })

  return pSeries(tasks)
}

module.exports = sync
