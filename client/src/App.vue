<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { IconBrandAmazon } from '@tabler/icons-vue'
import { Button } from '@/components/ui/button'
import { Input }  from '@/components/ui/input'
import { Label }  from '@/components/ui/label'
import { Badge }  from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'

// ── State ─────────────────────────────────────────────────────────────────
const email     = ref('')
const password  = ref('')
const site      = ref('')
const file      = ref(null)
const isDragging = ref(false)
const jobId     = ref(null)
const status    = ref('idle')   // idle | running | done | error
const logs      = ref([])
const progress  = ref(0)
const logBox    = ref(null)

const canStart = computed(() => file.value && email.value.trim() && password.value.trim())

// ── Persist credentials ───────────────────────────────────────────────────
onMounted(() => {
  email.value    = localStorage.getItem('evolup_email')    || ''
  password.value = localStorage.getItem('evolup_password') || ''
})
watch(email,    v => localStorage.setItem('evolup_email',    v.trim()))
watch(password, v => localStorage.setItem('evolup_password', v))

// ── File handling ─────────────────────────────────────────────────────────
function onDrop(e) {
  isDragging.value = false
  const f = e.dataTransfer.files[0]
  if (f?.name.endsWith('.xlsx')) file.value = f
}
function onFileChange(e) {
  if (e.target.files[0]) file.value = e.target.files[0]
}

// ── Log helpers ───────────────────────────────────────────────────────────
function lineClass(line) {
  const l = line.toLowerCase()
  if (l.includes('error') || l.includes('failed') || l.includes('fail')) return 'text-red-400'
  if (l.includes('success') || l.includes('imported successfully'))       return 'text-green-400'
  if (l.includes('===') || l.includes('found') || l.includes('logging'))  return 'text-blue-400'
  return 'text-slate-400'
}

function pushLog(line) {
  logs.value.push(line)
  const m = line.match(/\[(\d+)\/(\d+)\]/)
  if (m) progress.value = Math.round((parseInt(m[1]) / parseInt(m[2])) * 100)
  nextTick(() => {
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
  })
}

// ── Import ────────────────────────────────────────────────────────────────
async function startImport() {
  logs.value    = []
  progress.value = 0
  status.value  = 'running'
  jobId.value   = null

  const formData = new FormData()
  formData.append('file', file.value)
  formData.append('email', email.value.trim())
  formData.append('password', password.value)
  formData.append('site', site.value.trim())

  try {
    const res  = await fetch('/upload', { method: 'POST', body: formData })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Upload failed')
    jobId.value = data.jobId
  } catch (e) {
    pushLog(`Upload error: ${e.message}`)
    status.value = 'error'
    return
  }

  const evtSource = new EventSource(`/stream/${jobId.value}`)

  evtSource.addEventListener('log', e => pushLog(JSON.parse(e.data).line))

  evtSource.addEventListener('done', () => {
    evtSource.close()
    status.value   = 'done'
    progress.value = 100
  })

  evtSource.addEventListener('error', () => {
    evtSource.close()
    status.value = 'error'
  })

  evtSource.onerror = () => {
    evtSource.close()
    if (status.value === 'running') status.value = 'error'
  }
}

function download() {
  if (jobId.value) window.location.href = `/download/${jobId.value}`
}
</script>

<template>
  <div class="min-h-screen bg-muted/40 flex items-center justify-center p-6">
    <div class="w-full max-w-2xl space-y-4">

      <!-- Header card -->
      <Card>
        <CardHeader class="flex flex-row items-center gap-4 pb-4">
          <div class="w-12 h-12 rounded-xl bg-[#FF9900] flex items-center justify-center flex-shrink-0">
            <IconBrandAmazon class="w-7 h-7 text-white" :stroke-width="1.5" />
          </div>
          <div>
            <CardTitle class="text-xl">Evolup Amazon Importer</CardTitle>
            <CardDescription>Upload your Excel file and import products automatically</CardDescription>
          </div>
        </CardHeader>
      </Card>

      <!-- Credentials card -->
      <Card>
        <CardContent class="pt-6 space-y-4">
          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-2">
              <Label for="email">Evolup Email</Label>
              <Input id="email" v-model="email" type="email" placeholder="you@example.com" />
            </div>
            <div class="space-y-2">
              <Label for="password">Password</Label>
              <Input id="password" v-model="password" type="password" placeholder="••••••••" />
            </div>
          </div>
          <div class="space-y-2">
            <Label for="site">
              Site to import
              <span class="text-muted-foreground font-normal ml-1">(optional)</span>
            </Label>
            <Input id="site" v-model="site" type="text" placeholder="e.g. hochseeangeln-antares-de" />
          </div>
        </CardContent>
      </Card>

      <!-- Upload card -->
      <Card>
        <CardContent class="pt-6 space-y-4">
          <!-- Drop zone -->
          <div
            class="border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors"
            :class="isDragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary hover:bg-primary/5'"
            @dragover.prevent="isDragging = true"
            @dragleave="isDragging = false"
            @drop.prevent="onDrop"
            @click="$refs.fileInput.click()"
          >
            <input ref="fileInput" type="file" accept=".xlsx" class="hidden" @change="onFileChange" />
            <div class="text-4xl mb-3">📂</div>
            <p class="font-semibold text-foreground mb-1">Drop your Excel file here</p>
            <p class="text-sm text-muted-foreground">or click to browse — .xlsx only</p>
            <p v-if="file" class="mt-3 text-sm font-semibold text-primary">
              ✓ {{ file.name }}
            </p>
          </div>

          <Separator />

          <!-- Actions row -->
          <div class="flex items-center gap-3 flex-wrap">
            <Button
              :disabled="!canStart || status === 'running'"
              @click="startImport"
              class="min-w-[140px]"
            >
              {{ status === 'running' ? '⏳ Running…' : '▶ Start Import' }}
            </Button>

            <Badge v-if="status === 'running'" variant="outline" class="border-yellow-400 text-yellow-600 bg-yellow-50">
              ⏳ Running…
            </Badge>
            <Badge v-else-if="status === 'done'" variant="outline" class="border-green-500 text-green-700 bg-green-50">
              ✓ Complete
            </Badge>
            <Badge v-else-if="status === 'error'" variant="destructive">
              ✗ Error
            </Badge>

            <Button v-if="status === 'done'" variant="outline" class="border-green-500 text-green-700 hover:bg-green-50" @click="download">
              ⬇ Download Results
            </Button>
          </div>

          <!-- Progress bar -->
          <Progress v-if="status !== 'idle'" :model-value="progress" class="h-2" />
        </CardContent>
      </Card>

      <!-- Log card -->
      <Card v-if="logs.length">
        <CardHeader class="pb-3">
          <CardTitle class="text-sm font-semibold">Live Log</CardTitle>
        </CardHeader>
        <CardContent class="pt-0">
          <div
            ref="logBox"
            class="bg-slate-950 rounded-lg p-4 h-72 overflow-y-auto font-mono text-xs leading-relaxed"
          >
            <div
              v-for="(line, i) in logs"
              :key="i"
              class="whitespace-pre-wrap break-all"
              :class="lineClass(line)"
            >{{ line }}</div>
          </div>
        </CardContent>
      </Card>

    </div>
  </div>
</template>
