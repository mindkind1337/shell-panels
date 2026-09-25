<script setup>
// A single kanban task. Renders its title + current column and drives the shared
// task-board store directly (the brief: the card consumes the store) — renaming
// it, deleting it, and assigning it to an agent pane. It moves between columns
// by dragging it (TaskBoard takes the drop).
// It only ever reads/writes its own `task`, so a change to one card never forces
// its siblings to re-render.

import { ref, computed, nextTick } from 'vue'
import { updateTask, removeTask, assignAgent } from '../taskBoardStore'
import BrandIcon from './BrandIcon.vue'

const props = defineProps({
  task: { type: Object, required: true },
  // Agent panes available to assign work to: [{ id, title, agentId, accent }].
  // We store pane.id into task.paneId and label by title (falling back to
  // agentId). Optional so the card renders standalone (e.g. in tests).
  agentPanes: { type: Array, default: () => [] }
})

const emit = defineEmits(['focus-pane', 'review'])

// Drag a card to another column (the arrows stay, for the keyboard).
const TASK_DRAG_TYPE = 'application/x-tessel-task' // same type in TaskBoard.vue
const dragging = ref(false)
function onDragStart(e) {
  // Not from its controls (the agent menu, the buttons, the title being
  // edited): those keep working normally.
  const fromControl = e.target && e.target.closest && e.target.closest('select, input, button, textarea')
  if (editing.value || fromControl || !e.dataTransfer) return e.preventDefault()
  e.dataTransfer.setData(TASK_DRAG_TYPE, props.task.id)
  e.dataTransfer.effectAllowed = 'move'
  dragging.value = true
}


// --- Inline title editing (mirrors the pane-title pattern in TerminalPane) ----
const editing = ref(false)
const draft = ref('')
const titleInputEl = ref(null)

function startEdit() {
  draft.value = props.task.title
  editing.value = true
  nextTick(() => titleInputEl.value && titleInputEl.value.select())
}

function saveTitle() {
  if (!editing.value) return
  const next = draft.value.trim()
  // Blank title is rejected rather than silently wiping the task name.
  if (next) updateTask(props.task.id, { title: next })
  editing.value = false
}

function cancelEdit() {
  editing.value = false
}

function onDelete() {
  removeTask(props.task.id)
}

// --- Agent assignment --------------------------------------------------------
// <select> value is a string ('' = unassigned); map it back to a paneId or null.
const selectedPane = computed({
  get: () => props.task.paneId || '',
  set: (value) => assignAgent(props.task.id, value || null)
})

const assignedPane = computed(
  () => props.agentPanes.find((p) => p.id === props.task.paneId) || null
)

// Display label for a pane: its title, falling back to the agent id.
function paneLabel(pane) {
  const name = pane.title || pane.agentId || pane.id
  return pane.num ? `#${pane.num} ${name}` : name
}
</script>

<template>
  <div
    class="task-card"
    :class="{ dragging }"
    data-test="task-card"
    :draggable="!editing"
    title="Drag to another column"
    @dragstart="onDragStart"
    @dragend="dragging = false"
  >
    <div class="task-card-top">
      <input
        v-if="editing"
        ref="titleInputEl"
        v-model="draft"
        class="task-title-input"
        data-test="title-input"
        @blur="saveTitle"
        @keydown.enter.prevent="saveTitle"
        @keydown.escape.prevent="cancelEdit"
      />
      <span
        v-else
        class="task-title"
        data-test="card-title"
        title="Double-click to rename"
        @dblclick="startEdit"
        >{{ task.title }}</span
      >
      <button
        class="task-btn task-edit-btn"
        title="Rename task"
        aria-label="Rename task"
        data-test="edit-title"
        @click="startEdit"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M11.1 2.6a1.5 1.5 0 0 1 2.1 0l.2.2a1.5 1.5 0 0 1 0 2.1L6 12.3 2.8 13.2l.9-3.2 7.4-7.4Z"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
          />
          <path d="M9.8 3.9l2.3 2.3" stroke="currentColor" stroke-width="1.3" />
        </svg>
      </button>
    </div>

    <div class="task-card-meta">
      <span class="task-status" :class="`status-${task.column}`" data-test="card-status">{{
        task.column
      }}</span>
      <span
        v-if="assignedPane"
        class="task-assignee"
        data-test="assignee"
        :style="{ '--accent': assignedPane.accent }"
      >
        <BrandIcon :kind="assignedPane.agentId || ''" :size="13" />{{ paneLabel(assignedPane) }}
      </span>
      <span v-else class="task-assignee unassigned" data-test="assignee">Unassigned</span>
      <span
        v-if="task.column === 'review' && task.leadReview"
        class="task-lead"
        :class="task.leadReview"
        data-test="lead-review"
        :title="task.leadNote || ''"
        >{{ task.leadReview === 'approved' ? 'Lead approved' : 'Lead reviewing' }}</span
      >
    </div>

    <div v-if="assignedPane && assignedPane.track && task.column === 'doing'" class="task-track" :class="'track-' + assignedPane.track.level">
      <span>{{ assignedPane.track.text }}<template v-if="assignedPane.track.onTask"> · on this task {{ assignedPane.track.onTask }}</template></span>
      <span v-if="assignedPane.track.reason" class="task-track-reason">{{ assignedPane.track.reason }}</span>
    </div>

    <div v-if="task.worktree || task.brief" class="task-card-extra">
      <span v-if="task.worktree" class="task-branch" :title="task.worktree.path">{{ task.worktree.branch }}</span>
      <span v-if="task.brief" class="task-brief" :title="task.brief">{{ task.brief }}</span>
    </div>

    <div class="task-card-actions">
      <button
        v-if="task.column === 'review'"
        class="task-btn task-review-btn"
        title="See the changes, then merge, ask for changes or discard"
        data-test="review-task"
        @click="emit('review', task.id)"
      >
        Review
      </button>
      <button
        v-if="assignedPane && (task.column === 'doing' || task.column === 'review')"
        class="task-btn"
        title="Go to the agent doing this task"
        @click="emit('focus-pane', task.paneId)"
      >
        Show agent
      </button>
      <select
        v-model="selectedPane"
        class="task-assign"
        title="Assign to an agent pane"
        data-test="assign-select"
      >
        <option value="">Unassigned</option>
        <option v-for="pane in agentPanes" :key="pane.id" :value="pane.id">
          {{ paneLabel(pane) }}
        </option>
      </select>

      <button class="task-btn danger" title="Delete task" data-test="delete-task" @click="onDelete">
        ✕
      </button>
    </div>
  </div>
</template>
