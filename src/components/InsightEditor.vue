<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { store, DISPLAY_ORDER } from '../store'

const e = computed(() => store.state.insightEditor)
const draft = computed(() => e.value.draft)
const isNew = computed(() => !draft.value.id)

const SOURCE_OPTIONS = computed(() =>
  DISPLAY_ORDER
    .map(k => store.providerOf(k))
    .filter(p => !!p)
    .map(p => ({ key: p!.key, name: p!.name }))
)

async function onDraft() {
  const err = await store.draftInsight()
  if (err) ElMessage.warning(err)
  else ElMessage.success('已按五家回答提炼，检查后保存')
}

async function onSave() {
  const err = await store.saveInsight()
  if (err) ElMessage.warning(err)
  else ElMessage.success(isNew.value ? '结论卡已保存' : '已更新')
}
</script>

<template>
  <el-drawer v-model="store.state.insightEditor.open" size="560px" :with-header="false"
    class="kb-drawer" :close-on-click-modal="!e.saving" @close="store.closeInsightEditor()">
    <div class="kb-editor">
      <div class="kb-ed-head">
        <div>
          <h2>{{ isNew ? '新建结论卡' : '编辑结论卡' }}</h2>
          <div class="kb-ed-sub">把五家的共识与分歧，压缩成你自己的一句话判断。</div>
        </div>
        <button class="kb-x" title="关闭" @click="store.closeInsightEditor()">✕</button>
      </div>

      <div class="kb-ed-body">
        <div class="kb-field">
          <label>标题</label>
          <el-input v-model="draft.title" maxlength="40" show-word-limit placeholder="比如：卖家精灵 vs 西柚，选哪个" />
        </div>

        <div class="kb-field">
          <label>我当时问的问题</label>
          <el-input v-model="draft.question" type="textarea" :rows="2" resize="none"
            placeholder="一句话写清问题与背景" />
        </div>

        <div class="kb-field kb-core">
          <label>我的判断 <span class="kb-hint">这一栏最重要</span></label>
          <el-input v-model="draft.conclusion" type="textarea" :rows="4" resize="none"
            placeholder="结论 + 适用条件。例：先用卖家精灵做选品，关键词反查补西柚；预算 500 元/月以内不必两个都买。" />
        </div>

        <div class="kb-field">
          <label>多家一致的依据</label>
          <el-input v-model="draft.evidence" type="textarea" :rows="3" resize="none"
            placeholder="用；分隔，3-6 条。这些是你可以直接采信的部分。" />
        </div>

        <div class="kb-field">
          <label>分歧点 <span class="kb-hint">价值最高的部分</span></label>
          <el-input v-model="draft.disputes" type="textarea" :rows="3" resize="none"
            placeholder="每条写清「分歧点：谁主张什么」" />
        </div>

        <div class="kb-row">
          <div class="kb-field">
            <label>反例与风险</label>
            <el-input v-model="draft.counter" type="textarea" :rows="2" resize="none" placeholder="最值得警惕的情况" />
          </div>
          <div class="kb-field">
            <label>待验证</label>
            <el-input v-model="draft.followup" type="textarea" :rows="2" resize="none" placeholder="下一步要确认什么" />
          </div>
        </div>

        <div class="kb-field">
          <label>最终采信了哪几家</label>
          <el-checkbox-group v-model="draft.sources" class="kb-src">
            <el-checkbox v-for="s in SOURCE_OPTIONS" :key="s.key" :value="s.key">{{ s.name }}</el-checkbox>
          </el-checkbox-group>
        </div>

        <div class="kb-field">
          <label>标签</label>
          <el-select v-model="draft.tags" multiple filterable allow-create default-first-option
            placeholder="输入后回车创建，如 选品、广告投放" class="kb-tags" />
        </div>
      </div>

      <div class="kb-ed-foot">
        <div class="kb-foot-left">
          <el-button :loading="e.busy" :disabled="e.saving" @click="onDraft">
            {{ e.busy ? '提炼中…' : 'AI 提炼当前会话' }}
          </el-button>
          <span class="kb-cost">按一次调用计费</span>
        </div>
        <div class="kb-foot-right">
          <el-button text @click="store.closeInsightEditor()">取消</el-button>
          <el-button type="primary" :loading="e.saving" @click="onSave">保存</el-button>
        </div>
      </div>
    </div>
  </el-drawer>
</template>
