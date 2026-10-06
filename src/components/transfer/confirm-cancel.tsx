"use client";

import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { TextButton } from "./ui";

/** Cancelling a transfer always asks first, so a stray tap can't throw away progress. */
export function ConfirmCancel({ onConfirm, label = "Cancel transfer" }: { onConfirm: () => void; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TextButton onClick={() => setOpen(true)} className="self-center">
        {label}
      </TextButton>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="rounded-[18px] bg-[#151514] p-6 ring-white/10">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[19px] tracking-[-0.02em]">Cancel this transfer?</AlertDialogTitle>
            <AlertDialogDescription className="text-[15px] leading-relaxed">
              Current progress stops. You can start again at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel className="h-12 rounded-[12px] border-0 bg-white/[0.07] text-[15px] hover:bg-white/[0.11]">
              Keep going
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-12 rounded-[12px] bg-[#efeeea] text-[15px] text-[#0b0b0a] hover:bg-white"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Cancel transfer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
