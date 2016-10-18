/* eslint no-console:0, no-use-before-define:0, no-sync:0 */
// Require the node.js path module
// This provides us with what we need to interact with file paths
const pathUtil = require('path')

// Require our helper modules
const scandir = require('scandirectory')
const fsUtil = require('safefs')
const ignorefs = require('ignorefs')
const extendr = require('extendr')
const eachr = require('eachr')
const extractOpts = require('extract-opts')
const typeChecker = require('typechecker')
const {TaskGroup} = require('taskgroup')

// Require the node.js event emitter
// This provides us with the event system that we use for binding and trigger events
const {EventEmitter} = require('events')

/*
Now to make watching files more convient and managed, we'll create a class which we can use to attach to each file.
It'll provide us with the API and abstraction we need to accomplish difficult things like recursion.
We'll also store a global store of all the watchers and their paths so we don't have multiple watchers going at the same time
for the same file - as that would be quite ineffecient.
Events:
- `close` for when the watcher stops watching
- `change` for listening to change events, receives the arguments `changeType, fullPath, currentStat, previousStat`
*/
class Watcher extends EventEmitter {
	static watch (opts, next) {
		[opts, next] = extractOpts(opts, next)
		const me = this || Watcher

		// Prepare
		if ( me.watchers == null )  me.watchers = {}

		// Fetch
		let watcher = me.watchers[opts.path]
		if ( watcher ) {
			watcher.setConfig(opts)
			watcher.watch({}, next)
			return watcher
		}

		// Create
		watcher = me.watchers[opts.path] = new Watcher()
		watcher.setConfig(opts)
		watcher.once('close', function () {
			me.watchers[opts.path] = null
		})
		watcher.watch({}, next)
		return watcher
	}

	static statChanged (old, current) {
		// Has the file been deleted or created?
		const hasOld = old != null
		const hasCurrent = current != null
		if ( hasOld !== hasCurrent ) {
			return true
		}

		// Has the file contents changed?
		else if ( hasOld && hasCurrent ) {
			old = extendr.dereferenceJSON(old)
			current = extendr.dereferenceJSON(current)

			if ( old.atime != null )  delete old.atime
			if ( old.ctime != null )  delete old.ctime
			if ( current.atime != null )  delete current.atime
			if ( current.ctime != null )  delete current.ctime

			// The files contents have actually changed
			if ( JSON.stringify(old) !== JSON.stringify(current) ) {
				return true
			}

			// The files contents are the same
			else {
				return false
			}

		// The file still does not exist
		}
		else {
			return false
		}
	}

	// Now it's time to construct our watcher
	// We give it a path, and give it some events to use
	// Then we get to work with watching it
	constructor () {
		// Construct the EventEmitter
		super()

		// The path this class instance is attached to
		this.path = null

		// Our stat object, it contains things like change times, size, and is it a directory
		this.stat = null

		// The node.js file watcher instance, we have to open and close this, it is what notifies us of the events
		this.fswatcher = null

		// The watchers for the children of this watcher will go here
		// This is for when we are watching a directory, we will scan the directory and children go here
		this.children = {}

		// We have to store the current state of the watcher and it is asynchronous (things can fire in any order)
		// as such, we don't want to be doing particular things if this watcher is deactivated
		// valid states are: pending, active, closed, deleted
		this.state = 'pending'

		// The method we will use to watch the files
		// Preferably we use watchFile, however we may need to use watch in case watchFile doesn't exist (e.g. windows)
		this.method = null

		// Things for this.listener
		this.listenerTasks = null
		this.listenerTimeout = null

		// Initialize our object variables for our instance
		this.config = {
			// A single path to watch
			path: null,

			// Once listeners (optional, defaults to null)
			// multiple event listeners, forwarded to this.once
			once: null,

			// When listeners (optional, defaults to null)
			// multiple event listeners, forwarded to this.listen
			on: null,

			// Stat (optional, defaults to `null`)
			// a file stat object to use for the path, instead of fetching a new one
			stat: null,

			// Interval (optional, defaults to `5007`)
			// for systems that poll to detect file changes, how often should it poll in millseconds
			// if you are watching a lot of files, make this value larger otherwise you will have huge memory load
			// only appliable to the `watchFile` watching method
			interval: 5007,

			// Persistent (optional, defaults to `true`)
			// whether or not we should keep the node process alive for as long as files are still being watched
			// only appliable to the `watchFile` watching method
			persistent: true,

			// Catchup Delay (optional, defaults to `1000`)
			// Because of swap files, the original file may be deleted, and then over-written with by moving a swap file in it's place
			// Without a catchup delay, we would report the original file's deletion, and ignore the swap file changes
			// With a catchup delay, we would wait until there is a pause in events, then scan for the correct changes
			catchupDelay: 2 * 1000,

			// Preferred Methods (optional, defaults to `['watch','watchFile']`)
			// In which order should use the watch methods when watching the file
			preferredMethods: ['watch', 'watchFile'],

			// Follow symlinks, i.e. use stat rather than lstat. (optional, default to `true`)
			followLinks: true,

			// Ignore Paths (optional, defaults to `false`)
			// array of paths that we should ignore
			ignorePaths: false,

			// Ignore Hidden Files (optional, defaults to `false`)
			// whether or not to ignored files which filename starts with a `.`
			ignoreHiddenFiles: false,

			// Ignore Common Patterns (optional, defaults to `true`)
			// whether or not to ignore common undesirable file patterns (e.g. `.svn`, `.git`, `.DS_Store`, `thumbs.db`, etc)
			ignoreCommonPatterns: true,

			// Ignore Custom PAtterns (optional, defaults to `null`)
			// any custom ignore patterns that you would also like to ignore along with the common patterns
			ignoreCustomPatterns: null
		}
	}

	// Set our configuration
	setConfig (opts) {
		// Prepare
		const watchr = this
		const config = this.config

		// Apply
		extendr.extend(config, opts)

		// Path
		watchr.path = config.path

		// Stat
		if ( config.stat ) {
			watchr.stat = config.stat
			delete config.stat
		}

		// Add listener
		function addListener (eventName, listener, mode) {
			watchr.removeListener(eventName, listener)
			if ( mode === 'on' ) {
				watchr.on(eventName, listener)
			}
			else if ( mode === 'once' ) {
				watchr.once(eventName, listener)
			}
			else {
				throw new Error('unknown listen mode')
			}
			watchr.log('debug', `added listener: ${mode} ${eventName} for ${watchr.path}`)
		}
		function addListeners (eventName, listeners, mode) {
			eachr(listeners, function (listener) {
				addListener(eventName, listener, mode)
			})
		}
		function addMap (map, mode) {
			eachr(map, function (listeners, eventName) {
				// Array of event listeners
				if ( typeChecker.isArray(listeners) ) {
					addListeners(eventName, listeners, mode)
				}
				// Single event listener
				else {
					addListener(eventName, listeners, mode)
				}
			})
		}

		// Listeners
		if ( config.once ) {
			addMap(config.once, 'once')
			delete config.once
		}
		if ( config.on ) {
			addMap(config.on, 'on')
			delete config.on
		}

		// Chain
		return this
	}

	// Log
	log (...args) {
		// Emit the log event
		this.emit('log', ...args)

		// Chain
		return this
	}

	// Get Ignored Options
	getIgnoredOptions (opts = {}) {
		// Prepare
		const config = this.config

		// Return the ignore options
		return {
			ignorePaths: opts.ignorePaths != null ? opts.ignorePaths : config.ignorePaths,
			ignoreHiddenFiles: opts.ignoreHiddenFiles != null ? opts.ignoreHiddenFiles : config.ignoreHiddenFiles,
			ignoreCommonPatterns: opts.ignoreCommonPatterns != null ? opts.ignoreCommonPatterns : config.ignoreCommonPatterns,
			ignoreCustomPatterns: opts.ignoreCustomPatterns != null ? opts.ignoreCustomPatterns : config.ignoreCustomPatterns
		}
	}

	// Is Ignored Path
	isIgnoredPath (path, opts) {
		// Ignore?
		const ignore = ignorefs.isIgnoredPath(path, this.getIgnoredOptions(opts))

		// Log
		this.log('debug', `ignore: ${path} ${ignore ? 'yes' : 'no'}`)

		// Return
		return ignore
	}

	// Get the stat object
	// next(err, stat)
	getStat (opts, next) {
		// Figure out what stat method we want to use
		const method = this.config.followLinks ? 'stat' : 'lstat'

		// Fetch
		if ( this.stat && opts.reset !== true ) {
			next(null, this.stat)
		}
		else {
			fsUtil[method](this.path, (err, stat) => {
				if ( err )  return next(err)
				this.stat = stat
				return next(null, stat)
			})
		}

		// Chain
		return this
	}

	// Is Directory
	isDirectory () {
		// Return is directory
		return this.stat.isDirectory()
	}

	/*
	Listener
	A change event has fired

	Things to note:
	- watchFile method
		- Arguments
			- currentStat - the updated stat of the changed file
				- Exists even for deleted/renamed files
			- previousStat - the last old stat of the changed file
				- Is accurate, however we already have this
		- For renamed files, it will will fire on the directory and the file
	- watch method
		- Arguments
			- eventName - either 'rename' or 'change'
				- THIS VALUE IS ALWAYS UNRELIABLE AND CANNOT BE TRUSTED
			- filename - child path of the file that was triggered
				- This value can also be unrealiable at times
	- Both methods
		- For deleted and changed files, it will fire on the file
		- For new files, it will fire on the directory

	Output arguments for your emitted event will be:
	- for updated files the arguments will be: `'update', fullPath, currentStat, previousStat`
	- for created files the arguments will be: `'create', fullPath, currentStat, null`
	- for deleted files the arguments will be: `'delete', fullPath, null, previousStat`

	In the future we will add:
	- for renamed files: 'rename', fullPath, currentStat, previousStat, newFullPath
	- rename is possible as the stat.ino is the same for the delete and create
	*/
	listener (opts, next) {
		// Prepare
		const watchr = this
		const config = this.config
		const method = opts.method || this.method
		if ( !next ) {
			next = (err) => {
				if ( err ) {
					this.emit('error', err)
				}
			}
		}

		// Prepare properties
		let currentStat = null
		const previousStat = watchr.stat

		// Log
		watchr.log('debug', `watch fired on: ${watchr.path}`)

		// Delay the execution of the listener tasks, to once the change events have stopped firing
		if ( watchr.listenerTimeout != null ) {
			clearTimeout(watchr.listenerTimeout)
		}
		watchr.listenerTimeout = setTimeout(function () {
			const listenerTasks = watchr.listenerTasks
			watchr.listenerTasks = null
			watchr.listenerTimeout = null
			listenerTasks.run()
		}, config.catchupDelay || 0)

		// We are a subsequent listener, in which case, just listen to the first listener tasks
		if ( watchr.listenerTasks != null ) {
			watchr.listenerTasks.done(next)
			return this
		}

		// Start the detection process
		const tasks = watchr.listenerTasks = new TaskGroup(`listener tasks for ${this.path}`, {domain: false}).done(next)
		tasks.addTask('check if the file still exists', function (complete) {
			// Log
			watchr.log('debug', `watch evaluating on: ${watchr.path}`)

			// Check if the file still exists
			fsUtil.exists(watchr.path, function (exists) {
				// Apply local gobal property
				const fileExists = exists

				// If the file still exists, then update the stat
				if ( fileExists === false ) {
					// Log
					watchr.log('debug', `watch determined delete: ${watchr.path}`)

					// Apply
					watchr.close('deleted')
					watchr.stat = null

					// Clear the remaining tasks, as they are no longer needed
					tasks.clearRemaining()
					return complete()
				}

				// Update the stat of the file
				watchr.getStat({reset: true}, function (err, stat) {
					// Check
					if ( err )  return complete(err)

					// Update
					currentStat = stat

					// If there is a new file at the same path as the old file, then recreate the watchr
					if ( watchr.stat.birthtime.toString() !== previousStat.birthtime.toString() ) {
						watchr.log('debug', `watch determined replaced: ${watchr.path}`, watchr.stat.birthtime, previousStat.birthtime)
						return watchr.watch({reset: true}, complete)
					}
					// Otherwise it is the same file, so all done
					else {
						return complete()
					}
				})
			})
		})

		tasks.addTask('check if the file has changed', function () {
			// Check if it is the same
			// as if it is, then nothing has changed, so ignore
			if ( Watcher.statChanged(previousStat, currentStat) === false ) {
				watchr.log('debug', `watch determined same: ${watchr.path}`, previousStat, currentStat)

				// Clear the remaining tasks, as they are no longer needed
				tasks.clearRemaining()
			}
		})

		tasks.addGroup('check what has changed', function (addGroup, addTask, complete) {
			// Set this sub group to execute in parallel
			this.setConfig({concurrency: 0})

			// So let's check if we are a directory
			if ( watchr.isDirectory() === false ) {
				// If we are a file, lets simply emit the change event
				watchr.log('debug', `watch determined update: ${watchr.path}`)
				watchr.emit('change', 'update', watchr.path, currentStat, previousStat)
				return complete()
			}

			// We are a direcotry
			// Chances are something actually happened to a child (rename or delete)
			// and if we are the same, then we should scan our children to look for renames and deletes
			fsUtil.readdir(watchr.path, function (err, newFileRelativePaths) {
				// Error?
				if ( err )  return complete(err)

				// The watch method is fast, but not reliable, so let's be extra careful about change events
				if ( method === 'watch' ) {
					eachr(watchr.children, function (childFileWatcher, childFileRelativePath) {
						// Skip if the file has been deleted
						if ( newFileRelativePaths.indexOf(childFileRelativePath) === -1 )  return
						if ( !childFileWatcher )  return
						addTask('forward detection to child listener', function (complete) {
							watchr.log('debug', `Forwarding extensive change detection to child: ${childFileRelativePath} via: ${watchr.path}`)
							return childFileWatcher.listener({}, complete)
						})
					})
				}

				// Find deleted files
				eachr(watchr.children, function (childFileWatcher, childFileRelativePath) {
					// Skip if the file still exists
					if ( newFileRelativePaths.indexOf(childFileRelativePath) !== -1 )  return

					// Fetch full path
					const childFileFullPath = pathUtil.join(watchr.path, childFileRelativePath)

					// Skip if ignored file
					if ( watchr.isIgnoredPath(childFileFullPath) ) {
						watchr.log('debug', `watch ignored delete: ${childFileFullPath} via: ${watchr.path}`)
						return
					}

					// Emit the event and note the change
					watchr.log('debug', `watch determined delete: ${childFileFullPath} via: ${watchr.path}`)
					watchr.closeChild(childFileRelativePath, 'deleted')
				})

				// Find new files
				eachr(newFileRelativePaths, function (childFileRelativePath) {
					// Skip if we are already watching this file
					if ( watchr.children[childFileRelativePath] != null )  return
					watchr.children[childFileRelativePath] = false  // reserve this file

					// Fetch full path
					const childFileFullPath = pathUtil.join(watchr.path, childFileRelativePath)

					// Skip if ignored file
					if ( watchr.isIgnoredPath(childFileFullPath) ) {
						watchr.log('debug', `watch ignored create: ${childFileFullPath} via: ${watchr.path}`)
						return
					}

					// Emit the event and note the change
					addTask('watch the new child', function (complete) {
						watchr.log('debug', `watch determined create: ${childFileFullPath} via: ${watchr.path}`)
						watchr.watchChild({
							fullPath: childFileFullPath,
							relativePath: childFileRelativePath
						}, function (err, childFileWatcher) {
							if ( err )  return complete(err)
							watchr.emit('change', 'create', childFileFullPath, childFileWatcher.stat, null)
							return complete()
						})
					})
				})

				// Read the directory, finished adding tasks to the group
				return complete()
			})
		})

		// Tasks are executed via the timeout thing earlier

		// Chain
		return this
	}

	/*
	Close
	We will need something to close our listener for removed or renamed files
	As renamed files are a bit difficult we will want to close and delete all the watchers for all our children too
	Essentially it is a self-destruct
	*/
	close (reason) {
		// Prepare
		const watchr = this

		// Nothing to do? Already closed?
		if ( watchr.state !== 'active' )  return this

		// Close
		watchr.log('debug', `close: ${watchr.path}`)

		// Close our children
		eachr(watchr.children, function (childRelativePath) {
			watchr.closeChild(childRelativePath, reason)
		})

		// Close watchFile listener
		if ( watchr.method === 'watchFile' ) {
			fsUtil.unwatchFile(watchr.path)
		}

		// Close watch listener
		if ( watchr.fswatcher != null ) {
			watchr.fswatcher.close()
			watchr.fswatcher = null
		}

		// Updated state
		if ( reason === 'deleted' ) {
			watchr.state = 'deleted'
			watchr.emit('change', 'delete', watchr.path, null, watchr.stat)
		}
		else if ( reason === 'failure' ) {
			watchr.state = 'closed'
			watchr.log('warn', `Failed to watch the path ${watchr.path}`)
		}
		else {
			watchr.state = 'closed'
		}

		// Emit our close event
		watchr.emit('close', reason)

		// Chain
		return this
	}

	// Close a child
	closeChild (fileRelativePath, reason) {
		// Prepare
		const watchr = this

		// Check
		if ( watchr.children[fileRelativePath] != null ) {
			const watcher = watchr.children[fileRelativePath]
			if ( watchr ) {  // could be `false` for reservation
				watcher.close(reason)
			}
		}

		// Chain
		return this
	}

	/*
	Watch Child
	Setup watching for a child
	Bubble events of the child into our instance
	Also instantiate the child with our instance's configuration where applicable
	next(err, watchr)
	*/
	watchChild (opts, next) {
		// Prepare
		const watchr = this
		const config = this.config

		// Check if we are already watching
		if ( watchr.children[opts.relativePath] ) {
			// Provide the existing watcher
			if ( next ) {
				next(null, watchr.children[opts.relativePath])
			}
		}
		else {
			// Create a new watcher for the child
			watchr.children[opts.relativePath] = Watcher.watch({
				// Custom
				path: opts.fullPath,
				stat: opts.stat,
				once: {
					close () {
						delete watchr.children[opts.relativePath]
					}
				},
				on: {
					log (...args) {
						watchr.emit('log', ...args)
					},
					change (...args) {
						const [changeType, path] = args
						if ( changeType === 'delete' && path === opts.fullPath ) {
							watchr.closeChild(opts.relativePath, 'deleted')
						}
						// bubble the change event up to us from the child
						watchr.emit('change', ...args)
					}
				},

				// Next
				next,

				// Inherit
				interval: config.interval,
				persistent: config.persistent,
				catchupDelay: config.catchupDelay,
				preferredMethods: config.preferredMethods,
				ignorePaths: config.ignorePaths,
				ignoreHiddenFiles: config.ignoreHiddenFiles,
				ignoreCommonPatterns: config.ignoreCommonPatterns,
				ignoreCustomPatterns: config.ignoreCustomPatterns,
				followLinks: config.followLinks
			})
		}

		// Return the watchr
		return watchr.children[opts.relativePath]
	}

	/*
	Watch Children
	next(err)
	*/
	watchChildren (opts, next) {
		// Prepare
		const watchr = this
		const config = this.config

		// Cycle through the directory if necessary
		if ( watchr.isDirectory() ) {
			scandir({
				// Path
				path: watchr.path,

				// Options
				ignorePaths: config.ignorePaths,
				ignoreHiddenFiles: config.ignoreHiddenFiles,
				ignoreCommonPatterns: config.ignoreCommonPatterns,
				ignoreCustomPatterns: config.ignoreCustomPatterns,
				recurse: false,

				// Next
				next,

				// File and Directory Actions
				action (fullPath, relativePath, nextFile) {
					// Check we are still releveant
					if ( watchr.state !== 'active' ) {
						return nextFile(null, true)  // skip without error
					}

					// Watch this child
					watchr.watchChild({fullPath, relativePath}, function (err) {
						return nextFile(err)
					})
				}
			})

		}
		else {
			next()
		}

		// Chain
		return this
	}

	// Setup the methods
	// next(err)
	watchMethod (method, next) {
		if ( method === 'watch' ) {
			// Check
			if ( fsUtil.watch == null ) {
				const err = new Error('watch method is not supported on this environment, fs.watch does not exist')
				return next(err)
			}

			// Watch
			try {
				this.fswatcher = fsUtil.watch(this.path, (...args) => this.listener({method, args}))
				// must pass the listener here instead of doing fswatcher.on('change', opts.listener)
				// as the latter is not supported on node 0.6 (only 0.8+)
			}
			catch ( err ) {
				return next(err)
			}

			// Success
			return next()
		}
		else if ( method === 'watchFile' ) {
			// Check
			if ( fsUtil.watchFile == null ) {
				const err = new Error('watchFile method is not supported on this environment, fs.watchFile does not exist')
				return next(err)
			}

			// Watch
			try {
				fsUtil.watchFile(this.path, {
					persistent: this.config.persistent,
					interval: this.config.interval
				}, (...args) => this.listener({method, args}))
			}
			catch ( err ) {
				return next(err)
			}

			// Success
			return next()
		}
		else {
			const err = new Error('unknown watch method')
			return next(err)
		}
	}

	/*
	Watch Self
	next(err)
	*/
	watchSelf (opts, next) {
		// Prepare
		const watchr = this
		if ( opts.errors == null )  opts.errors = []
		if ( opts.preferredMethods == null )  opts.preferredMethods = this.config.preferredMethods

		// Attempt the watch methods
		if ( opts.preferredMethods.length ) {
			const method = opts.preferredMethods[0]
			watchr.watchMethod(method, function (err) {
				if ( err ) {
					// try again with the next preferred method
					opts.preferredMethods = opts.preferredMethods.slice(1)
					opts.errors.push(err)
					return watchr.watchSelf(opts, next)
				}

				// Apply
				watchr.method = method
				watchr.state = 'active'

				// Forward
				return next()
			})
		}
		else {
			const err = new Error(`no watch methods left to try, failures are: ${opts.errors}`)
			next(err)
		}

		// Chain
		return this
	}

	/*
	Watch
	Setup the native watching handlers for our path so we can receive updates on when things happen
	If the next argument has been received, then add it is a once listener for the watching event
	If we are already watching this path then let's start again (call close)
	If we are a directory, let's recurse
	If we are deleted, then don't error but return the isWatching argument of our completion callback as false
	Once watching has completed for this directory and all children, then emit the watching event
	next(err, watchr)
	*/
	watch (opts, next) {
		// Prepare
		const watchr = this

		// Add the listener
		if ( next ) {
			this.once('watching', next)
		}

		// Check
		if ( watchr.state === 'active' && opts.reset !== true ) {
			watchr.emit('watching', null, watchr)
			return this
		}

		// Close our all watch listeners
		watchr.close()

		// Log
		watchr.log('debug', `watch init: ${this.path}`)

		// Fetch the stat then try again
		watchr.getStat({}, function (err) {
			if ( err )  return watchr.emit('watching', err, watchr)

			// Watch ourself
			watchr.watchSelf({}, function (err) {
				if ( err )  return watchr.emit('watching', err, watchr)

				// Watch the childrne
				watchr.watchChildren({}, function (err) {
					if ( err )  watchr.close('child failure')  // continue
					watchr.log('debug', `watch done: ${watchr.path} ${err}`)
					watchr.emit('watching', err, watchr)
				})
			})
		})

		// Chain
		return this
	}
}

// Now let's provide node.js with our public API
// In other words, what the application that calls us has access to
module.exports = Watcher
