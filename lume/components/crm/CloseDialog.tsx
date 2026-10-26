'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

/**
 * Won / Lost asks for a one-line reason, then files a confirmation
 * (`crm_close_deal`) — the deal moves only after Approve in Telegram or Lume.
 */
export function CloseDialog({
  target,
  onCancel,
  onConfirm,
  busy,
  initialReason = '',
}: {
  target: { stage: 'Won' | 'Lost'; label: string } | null
  initialReason?: string
  onCancel: () => void
  onConfirm: (reason: string) => void
  busy?: boolean
}) {
  const [reason, setReason] = useState(initialReason)
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(o) => {
        if (!o) {
          setReason('')
          onCancel()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (reason.trim()) onConfirm(reason.trim())
          }}
          className="grid gap-4"
        >
          <DialogHeader>
            <DialogTitle>Mark {target?.label} as {target?.stage}?</DialogTitle>
            <DialogDescription>
              One line on why. This asks for approval first (Telegram or Pending approvals); the deal moves once you approve.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
            placeholder={target?.stage === 'Won' ? 'e.g. Signed the pilot, starts Monday' : 'e.g. Went with an in-house team'}
            aria-label="Reason"
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!reason.trim() || busy}>
              Request approval
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
